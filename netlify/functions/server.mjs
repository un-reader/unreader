import serverless from 'serverless-http';
import { app } from '../../index.js';

const handle = serverless(app, { basePath: '/.netlify/functions/server' });

export const handler = async (event, context) => {
  return handle(event, context);
};
