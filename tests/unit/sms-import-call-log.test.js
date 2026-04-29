/**
 * Android SMS Backup & Restore call-log import tests.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');

function writeCallExport(dir) {
    const exportDir = path.join(dir, 'export');
    fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(path.join(exportDir, 'calls.xml'), `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<calls count="3">
  <call number="+15550100" duration="120" date="1700000000000" type="2" readable_date="Nov 14, 2023 22:13:20" contact_name="Ada" />
  <call number="+15550100" duration="0" date="1700000060000" type="3" readable_date="Nov 14, 2023 22:14:20" contact_name="Ada" />
  <call number="+15550200" duration="60" date="1700000120000" type="1" readable_date="Nov 14, 2023 22:15:20" contact_name="Grace" />
</calls>`);
    return exportDir;
}

test('[SMS Import] imports SyncTech call-log XML as call relationship events', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-sms-calls-'));
    const exportDir = writeCallExport(dir);
    const outDir = path.join(dir, 'sms');

    execFileSync('node', [path.join(ROOT, 'sources/sms/import.js')], {
        cwd: ROOT,
        env: { ...process.env, SMS_EXPORT_DIR: exportDir, SMS_OUT_DIR: outDir, CRM_DATA_DIR: dir },
        encoding: 'utf8',
    });

    const contacts = JSON.parse(fs.readFileSync(path.join(outDir, 'contacts.json'), 'utf8'));
    const threads = JSON.parse(fs.readFileSync(path.join(outDir, 'messages.json'), 'utf8'));

    assert.equal(contacts.length, 2);
    const ada = contacts.find(c => c.name === 'Ada');
    assert.equal(ada.messageCount, 0);
    assert.equal(ada.callCount, 2);

    const adaThread = threads.find(t => t.contactName === 'Ada');
    assert.equal(adaThread.messages.length, 2);
    assert.deepEqual(adaThread.messages.map(m => m.callType), ['outgoing', 'missed']);
    assert.equal(adaThread.messages[0].type, 'call');
    assert.equal(adaThread.messages[0].direction, 'sent');
    assert.equal(adaThread.messages[0].durationSeconds, 120);
    assert.equal(adaThread.messages[1].direction, 'received');

    fs.rmSync(dir, { recursive: true, force: true });
});
