import fs from "fs/promises"
import zlib from "zlib"
import mime from "mime"

const Server = WEB_ROOT => {
  const serve_file = file_path => (req, res) => {
    // Strip query string + hash before mapping into the filesystem — otherwise a request like
    // /foo.js?v=1 lands on disk as "foo.js?v=1" and 404s. Path-only is what we want for static.
    const reqPath = req.url.split(/[?#]/, 1)[0]
    let url =
      file_path === undefined
        ? //security!
          WEB_ROOT + decodeURIComponent(reqPath.replaceAll(/\.+/g, "."))
        : file_path
    console.log({url})

    return fs
      .readFile(url)
      .then(data => {
        console.log(data)
        //let encoding = req.url.match(/.gz$/)?'gzip':'identity'
        //      zlib.gzip(data, function (_, data) {
        res.writeHead(200, {
          //'Content-Encoding': 'gzip',
          "Accept-Ranges": "bytes",
          "Content-Type": mime.getType(url),
          "Content-Length": data.length,
        })
        res.end(data)
        //     })
      })
      .catch(error => {
        throw "404"
        //res.writeHead(404)
        //res.end(`<h1>404!</h1><br><a href="javascript:history.back()">(Go Back)</a>`)
      })
  }

  let serve_JSON = object => (req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
    })
    res.end(JSON.stringify(object))
  }

  let serve_JSONSSE = (req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })

    const event = data => {
      res.write(`${JSON.stringify(data)}\n`)
    }

    const finish = (data = null) => {
      if (data) {
        res.write(`${JSON.stringify(data)}\n`)
        //idfk this doesn't work with the frontend for whatever reason
        //res.end(JSON.stringify(data))
      }
      res.end()
    }

    return {event, finish}
  }

  let get_JSON_from_req = req =>
    new Promise((res, rej) => {
      if (req.method === "POST") {
        let body = ""
        req.on("data", chunk => {
          body += chunk
        })
        req.on("end", async () => {
          try {
            const jsonData = JSON.parse(body)
            res(jsonData)
          } catch (e) {
            rej(e)
          }
        })
      } else {
        throw "internal server error in get_JSON_from_req"
      }
    })

  let accept_JSON = func => (req, res) => {
    if (
      req.method === "POST" &&
      req.headers["content-type"] === "application/json"
    ) {
      let body = ""
      req.on("data", chunk => {
        body += chunk
      })
      req.on("end", async () => {
        try {
          const jsonData = JSON.parse(body)
          const response = await func(jsonData)
          res.writeHead(200, {"Content-Type": "application/json"})
          res.end(JSON.stringify(response))
        } catch (error) {
          res.writeHead(400, {"Content-Type": "application/json"})
          res.end(JSON.stringify({error: "Invalid JSON"}))
        }
      })
    } else {
      res.writeHead(405, {"Content-Type": "application/json"})
      res.end(JSON.stringify({error: "Method Not Allowed"}))
    }
  }

  let build_router = (routing_table, def) => {
    let route = query => {
      const route = routing_table
        .keys()
        .find(key => query.match("(^|^/)" + key + "$"))
      return routing_table.get(route)
    }

    return async (request, response) => {
      const {method, url} = request
      console.log({method, url})
      try {
        // Route on path only — strip ?query and #fragment before matching. Without this,
        // /foo?bar=1 would never match a routing-table entry keyed on /foo.
        const pathOnly = request.url.split(/[?#]/, 1)[0]
        let query =
          "/" +
          pathOnly
            .split("/")
            .filter(a => a)
            .join("/")
        let matched_entry = route(query) || def
        console.log(matched_entry)

        if (matched_entry?.[method]) {
          await matched_entry[method](request, response)
        } else {
          throw "no matched entry"
        }
      } catch (error) {
        let error_code = parseInt(error)
        if (error_code != error) error_code = 500
        console.error(error)
        response.writeHead(error_code)
        response.end(`
      <h3>${error_code}</h3>
      <pre><code>
      ${error}
      ======================
      ${error.stack}
      </code></pre>
        `)
      }
    }
  }
  return {
    build_router,
    serve_JSON,
    serve_file,
    serve_JSONSSE,
    accept_JSON,
    get_JSON_from_req,
  }
}

export default Server
