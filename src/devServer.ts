import { DevServerConfig } from "./config";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import RSDWServer from "react-server-dom-webpack/server";
import register from "react-server-dom-webpack/node-register";
import Module from "module";
import * as swc from "@swc/core";

const { renderToPipeableStream } = RSDWServer;

// current working directory
const cwd = process.cwd();
const require = Module.createRequire(import.meta.url);
const extensions = [".ts", ".tsx"];

// HACK to emulate webpack require
const codeToInject = swc.parseSync(`
  globalThis.__webpack_require__ = function (id) {
    return import(id);
  };
`);

// find the file in cwd
// eg. user visits /hello -> search for hello, hello.ts, hello.tsx
const resolveFile = (name: string) => {
  for (const ext of ["", ...extensions]) {
    try {
      const fname = path.join(cwd, name + ext);
      fs.statSync(fname);
      return fname;
    } catch (e) {
      continue;
    }
  }
  throw new Error(`File not found: ${name}`);
};

const transpileTypeScript = (m: any, fname: string) => {
  let { code } = swc.transformFileSync(fname, {
    jsc: {
      parser: {
        syntax: "typescript",
        tsx: fname.endsWith(".tsx"),
      },
      transform: {
        react: {
          runtime: "automatic",
        },
      },
    },
    module: {
      type: "commonjs",
    },
  });
  // HACK to pull directive to the root
  // FIXME praseFileSync & transformSync would be nice, but encounter:
  // https://github.com/swc-project/swc/issues/6255
  const p = code.match(/(?:^|\n|;)("use (?:client|server)";)/);
  if (p) {
    code = p[1] + code;
  }
  return m._compile(code, fname);
};

extensions.forEach((ext) => {
  (Module as any)._extensions[ext] = transpileTypeScript;
});

const savedLoad = (Module as any)._load;
(Module as any)._load = (fname: string, m: any, isMain: boolean) => {
  try {
    fname = resolveFile(fname);
  } catch (e) {
    // ignored
  }
  return savedLoad(fname, m, isMain);
};

const getVersion = (name: string) => {
  const packageJson = require(path.join(cwd, "package.json"));
  const version = packageJson.dependencies[name];
  return version ? `@${version}` : "";
};

const bundlerConfig = new Proxy(
  {},
  {
    get(_target, filepath: string) {
      return new Proxy(
        {},
        {
          get(_target, name) {
            return {
              id: "/" + path.relative("file://" + cwd, filepath),
              chunks: [],
              name,
              async: true,
            };
          },
        }
      );
    },
  }
);

register();

export function startDevServer(config?: DevServerConfig) {
  const server = http.createServer(async (req, res) => {
    try {
      // req.url is the path like /joel or /
      // constructing a url based on the request host and req.url
      const url = new URL(req.url || "", "http://" + req.headers.host);
      if (url.pathname === "/") {
        // get the index.html from current working directory
        const fname = path.join(cwd, "index.html");
        // get the stats of the file
        const stat = await fsPromises.stat(fname);
        res.setHeader("Content-Length", stat.size);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        // read the file (index.html) and send the contents as a stream in res
        fs.createReadStream(fname).pipe(res);
        return;
      }

      // get the file name like /Users/joelmathew/WebProjects/todo-previous/src/index.tsx
      const fname = resolveFile(url.pathname);

      // ok this comes at the end
      if (url.searchParams.has("__RSC")) {
        const name = url.searchParams.get("__RSC_NAME") || "default";
        url.searchParams.delete("__RSC");
        url.searchParams.delete("__RSC_NAME");

        // this transpiles the ts to js
        // TODO can we use node:vm?
        const mod = require(fname);

        // this props is passed in the url..
        const props = Object.fromEntries(url.searchParams.entries());
        renderToPipeableStream((mod[name] || mod)(props), bundlerConfig).pipe(
          res
        );
        return;
      }

      // we need to get the typescript and transpile it to js
      // check if atleast one element in array matches
      if (extensions.some((ext) => fname.endsWith(ext))) {
        const mod = await swc.parseFile(fname, {
          syntax: "typescript",
          tsx: fname.endsWith(".tsx"),
        });
        // we are injecting parsed code thats why .body
        mod.body.push(...codeToInject.body);

        // HACK we should transpile by ourselves in the future
        // we are modifying the import statements to import from a cdn since browsers cannot understand raw import from "react" or "lodash"
        mod.body.forEach((node) => {
          if (node.type === "ImportDeclaration") {
            const match = node.source.value.match(/^([-\w]+)(\/[-\w\/]+)?$/);

            // match[1] is the module name
            // match[2] is any path in the module
            // react-dom/server
            // match[1] = react-dom
            // match[2] = server
            if (match) {
              node.source.value = `https://esm.sh/${match[1]}${getVersion(
                match[1] as string
              )}${match[2] || ""}`;
            }
          }
        });

        // transform the code for react and browser
        const { code } = await swc.transform(mod, {
          sourceMaps: "inline",
          jsc: {
            transform: {
              react: {
                runtime: "automatic",
                importSource: `https://esm.sh/react${getVersion("react")}`,
              },
            },
          },
        });
        res.setHeader("Content-Length", code.length);
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.end(code);
        return;
      }
      const stat = await fsPromises.stat(fname);
      res.setHeader("Content-Length", stat.size);
      // FIXME use proper content-type
      res.setHeader("Content-Type", "application/octet-stream");
      fs.createReadStream(fname).pipe(res);
    } catch (error) {
      console.info(error);
    }
  });

  server.listen(config?.port ?? 3000);
}
