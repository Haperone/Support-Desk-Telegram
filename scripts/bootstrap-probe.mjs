export async function probeManagerEndpoint(origin, secret, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${origin}/tg/manager`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch {
    throw new Error('Worker не ответил по PUBLIC_BASE_URL. Сверьте адрес с URL, показанным Wrangler после deploy.');
  }
  if (response.status !== 400 || (await response.text()) !== 'Invalid update') {
    throw new Error('Webhook-адрес или секрет Worker не совпадают с установкой. Telegram пока не подключён.');
  }
}

export async function probeMonitorEndpoint(origin, secret, fetchImpl = fetch) {
  let snapshot;
  try {
    const response = await fetchImpl(`${origin}/health/status`, {
      headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(40_000), redirect: 'error',
    });
    if (![200, 503].includes(response.status)) throw new Error('Invalid status');
    snapshot = await response.json();
  } catch {
    throw new Error('Монитор не подтвердил защищённый статус. Проверьте его адрес, STATUS_READ_TOKEN и версию кода, затем продолжите установку.');
  }
  if (snapshot?.schemaVersion !== 1 || !Number.isFinite(Date.parse(snapshot.measuredAt))
    || Math.abs(Date.now() - Date.parse(snapshot.measuredAt)) > 120_000
    || snapshot.monitorDatabase !== 'available' || snapshot.support !== 'available') {
    throw new Error('Проверка монитора не подтвердила чтение обеих БД и связь с основным Worker. Повторите установку после восстановления доступа.');
  }
  // Fresh installations may have no Cron results or alert route yet. Do not require healthy.
  return { databasesAvailable: true, monitoringReady: snapshot.overall === 'healthy' };
}
