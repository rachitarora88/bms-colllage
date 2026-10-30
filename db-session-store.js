const session = require('express-session');
const { get, run } = require('./db');

class DatabaseSessionStore extends session.Store {
  get(sid, callback) {
    get('SELECT sess, expires FROM sessions WHERE sid = ?', [sid])
      .then(async (row) => {
        if (!row) {
          callback(null, null);
          return;
        }

        if (row.expires <= Date.now()) {
          await run('DELETE FROM sessions WHERE sid = ?', [sid]);
          callback(null, null);
          return;
        }

        callback(null, JSON.parse(row.sess));
      })
      .catch(callback);
  }

  set(sid, value, callback = () => {}) {
    const expires = value.cookie && value.cookie.expires
      ? new Date(value.cookie.expires).getTime()
      : Date.now() + (value.cookie && value.cookie.maxAge ? value.cookie.maxAge : 86400000);

    run(
      'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires',
      [sid, JSON.stringify(value), expires],
    ).then(() => callback(null)).catch(callback);
  }

  touch(sid, value, callback = () => {}) {
    const expires = value.cookie && value.cookie.expires
      ? new Date(value.cookie.expires).getTime()
      : Date.now() + (value.cookie && value.cookie.maxAge ? value.cookie.maxAge : 86400000);

    run('UPDATE sessions SET expires = ? WHERE sid = ?', [expires, sid])
      .then(() => callback(null))
      .catch(callback);
  }

  destroy(sid, callback = () => {}) {
    run('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => callback(null))
      .catch(callback);
  }
}

module.exports = DatabaseSessionStore;
