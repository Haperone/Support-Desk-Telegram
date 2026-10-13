// Production D1 rejects a sixth term in one compound SELECT. Node's SQLite
// allows 500, so execute-time test adapters must enforce this separately.
export function assertD1CompoundSelectLimit(sql) {
  const scopes = [0];
  const tokens = sql.match(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[();]|\b(?:UNION|INTERSECT|EXCEPT)\b/gi) || [];
  for (const token of tokens) {
    if (token === '(') scopes.push(0);
    else if (token === ')') scopes.pop();
    else if (token === ';') scopes[scopes.length - 1] = 0;
    else if (/^(UNION|INTERSECT|EXCEPT)$/i.test(token) && ++scopes[scopes.length - 1] >= 5) {
      throw new Error('D1_ERROR: too many terms in compound SELECT: SQLITE_ERROR');
    }
  }
}
