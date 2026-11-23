import open from "open";
import { openSession } from "./session.js";
import { createViewerServer } from "./http.js";

const session = await openSession();
const server = createViewerServer(session);
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close();
  try {
    await session.close();
  } finally {
    process.exit(code);
  }
}

server.on("error", (error) => {
  console.error(error.message);
  void close(1);
});
const native = process.argv.includes("--native");
if (native) {
  process.stdin.resume();
  process.stdin.once("end", () => void close());
}
server.listen(Number(process.env.PORT || (native ? 0 : 18379)), "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + server.address().port;
  if (native) {
    console.log(url);
  } else {
    console.log("Maestro Viewer → " + url);
    if (!process.argv.includes("--no-open"))
      open(url).catch((error) => console.error(error.message));
  }
});
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
