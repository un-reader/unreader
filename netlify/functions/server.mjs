import serverless from 'serverless-http';
import { app, databaseReady } from '../../index.js';

const handle = serverless(app, { basePath: '/.netlify/functions/server' });

export const handler = async (event, context) => {
  await databaseReady;
  return handle(event, context);
};
