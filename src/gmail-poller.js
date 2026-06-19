// Poller de Gmail por la Gmail API (scope gmail.readonly). Alternativa a IMAP para
// cuentas Google: hace polling del historial cada POLL_MS y emite los pagos detectados.
// Outlook/IMAP manual siguen por el ImapWatcher; esto es solo para provider=google.

import { EventEmitter } from 'node:events';
import { logger } from './logger.js';
import { getAccount, updateAccountHistory } from './storage.js';
import { getHistoryId } from './gmail-api.js';
import { scanGmailFromHistory } from './gmail-scan.js';

const POLL_MS = 8000; // cada 8s

export class GmailPoller extends EventEmitter {
  constructor(account) {
    super();
    this.id = account.id;
    this.email = account.email;
    this._timer = null;
    this._stopping = false;
    this._busy = false;
  }

  async start() {
    // Fijar baseline (historyId actual) para no procesar correos viejos.
    const acc = getAccount(this.id);
    if (acc && !acc.last_history_id) {
      try {
        const hid = await getHistoryId(acc.refreshToken);
        updateAccountHistory(this.id, hid);
      } catch (e) {
        logger.error({ id: this.id, err: e.message }, 'gmail baseline historyId failed');
      }
    }
    logger.info({ id: this.id, email: this.email }, 'gmail poller started');
    this._timer = setInterval(() => this._tick(), POLL_MS);
  }

  async _tick() {
    if (this._busy || this._stopping) return;
    this._busy = true;
    try {
      const acc = getAccount(this.id); // fresco: last_history_id + refreshToken
      if (acc) {
        await scanGmailFromHistory(acc, (p) => this.emit('payment', p));
      }
    } catch (e) {
      // historyId demasiado viejo (404) -> rebaseline
      if (String(e.message).includes('404') || /historyId/i.test(e.message)) {
        try {
          const acc = getAccount(this.id);
          const hid = await getHistoryId(acc.refreshToken);
          updateAccountHistory(this.id, hid);
          logger.warn({ id: this.id }, 'gmail historyId rebaseline');
        } catch {}
      } else {
        logger.error({ id: this.id, err: e.message }, 'gmail poll error');
      }
    } finally {
      this._busy = false;
    }
  }

  async stop() {
    this._stopping = true;
    if (this._timer) clearInterval(this._timer);
  }
}
