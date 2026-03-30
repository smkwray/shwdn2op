import { config } from "./config.js";
import { buildServer } from "./server.js";

const app = buildServer();

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
