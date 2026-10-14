require('dotenv').config({ quiet: true });

const { buildServer } = require('./server');

const { app, scheduler, config } = buildServer();

scheduler.start(config.schedulerIntervalSeconds);

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
});
