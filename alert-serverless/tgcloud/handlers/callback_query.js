import { api, db, fetch } from 'sdk';
import { handleCallback } from '../lib/status.js';

export default query => handleCallback(query, { api, db, fetch });
