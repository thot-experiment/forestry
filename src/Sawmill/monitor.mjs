import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'forestry.db');
const db = new sqlite.DatabaseSync(dbPath);

const server = http.createServer((req, res) => {
    if (req.url === '/') {
        let events = [];
        try {
            events = db.prepare('SELECT timestamp, event_type, zone, payload FROM events ORDER BY timestamp DESC LIMIT 100').all();
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`DB error: ${e.message}\n\nDB path: ${dbPath}\nIs Lumberjack running ingests?`);
            return;
        }
        const counts = {};
        for (const t of ['sessions', 'poll', 'events', 'snapshots', 'cleu']) {
            try { counts[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; }
            catch { counts[t] = '?'; }
        }
        const html = `
            <html>
            <head><title>Sawmill Monitor</title></head>
            <body style="font-family: monospace; background: #111; color: #eee; padding: 20px;">
                <h1>Sawmill Live Tail</h1>
                <p>counts: sessions=${counts.sessions}  poll=${counts.poll}  events=${counts.events}  snapshots=${counts.snapshots}  cleu=${counts.cleu}</p>
                <table border="1" style="width: 100%; border-collapse: collapse;">
                    <tr><th>Time</th><th>Event</th><th>Zone</th><th>Payload</th></tr>
                    ${events.map(e => `<tr><td>${e.timestamp}</td><td>${e.event_type ?? ''}</td><td>${e.zone ?? ''}</td><td>${e.payload ?? ''}</td></tr>`).join('')}
                </table>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </body>
            </html>
        `;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    } else {
        res.writeHead(404);
        res.end();
    }
});
const PORT = 3333;
server.listen(PORT, () => {
    console.log(`Monitoring UI running at http://localhost:${PORT}  (db: ${dbPath})`);
});
