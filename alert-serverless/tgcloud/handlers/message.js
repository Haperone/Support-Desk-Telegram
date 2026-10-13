import { api, db, fetch } from 'sdk';
import { handleMessage } from '../lib/status.js';

export default message => handleMessage(message, { api, db, fetch });
