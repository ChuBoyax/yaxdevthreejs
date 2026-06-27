// Tiny static dev server — run with: node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const PORT = 5173;
const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

http
  .createServer((req, res) => {
    let url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/") url = "/index.html";
    const filePath = path.join(root, url);

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
        return;
      }
      const type = types[path.extname(filePath)] || "application/octet-stream";
      const range = req.headers.range;

      // Range support (needed for smooth audio/video streaming + seeking)
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        res.writeHead(206, {
          "Content-Type": type,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": stat.size });
      fs.createReadStream(filePath).pipe(res);
    });
  })
  .listen(PORT, () => console.log(`Serving http://localhost:${PORT}`));
