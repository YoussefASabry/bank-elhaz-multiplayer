const logs = [];

export function log(...args) {
  const msg = args.join(' ');
  logs.push(msg);
  console.log(msg);
}

export function getLogs() {
  return logs;
}

export function clearLogs() {
  logs.length = 0;
}
