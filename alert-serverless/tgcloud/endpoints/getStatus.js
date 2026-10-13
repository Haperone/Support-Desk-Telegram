import { db, fetch, EndpointError } from 'sdk';
import { authorized, loadStatus } from '../lib/status.js';
import { statusText } from '../lib/copy.js';

export default async function (_input, ctx) {
  if (!authorized(ctx?.initData?.user?.id)) throw new EndpointError(statusText(undefined, 'forbidden'));
  return loadStatus({ db, fetch });
}
