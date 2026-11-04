#!/usr/bin/env node
/*
 * Prints a DASHBOARD_LOGIN_PASSWORD_HASH line for the dashboard sign-in.
 *   npm run auth:hash-password            -> asks twice without echoing
 *   printf '%s' "$PW" | npm run -s auth:hash-password   -> reads stdin
 * Only the hash is printed; the password is never written anywhere.
 */
import readline from 'node:readline';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../api/passwordHash.js';

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(prompt);
    let value = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          input.setRawMode(false);
          process.stderr.write('\n');
          reject(new Error('취소했습니다.'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on('data', onData);
  });
}

async function readStdin() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);
  return lines.join('\n').replace(/\r?\n$/, '');
}

async function main() {
  let password;
  if (process.stdin.isTTY) {
    password = await askHidden(`새 비밀번호 (${MIN_PASSWORD_LENGTH}자 이상): `);
    const confirm = await askHidden('한 번 더 입력: ');
    if (password !== confirm) throw new Error('두 비밀번호가 다릅니다.');
  } else {
    password = await readStdin();
  }
  console.log(`DASHBOARD_LOGIN_PASSWORD_HASH=${hashPassword(password)}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
