import { config } from "./config.js";
import { buildServer } from "./server.js";

const app = buildServer();
const shutdown = () => { void app.close().catch((error) => { app.log.error(error); process.exitCode = 1; }); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
app.addHook("onClose", async () => {
  process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown);
});

app
  .listen({
    host: config.host,
    port: config.port
  })
  .then((address) => {
    app.log.info(`Companion listening on ${address}`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
