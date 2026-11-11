import 'server-only';

// The website chat's route logic (chatSession.js), only for server code: it reads NODE_API_KEY.
export { startChatSession, sendChatMessage, endChatSession } from './chatSession.js';
