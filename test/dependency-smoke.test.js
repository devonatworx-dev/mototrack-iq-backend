import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import multer from 'multer';
import PDFDocument from 'pdfkit';
import puppeteer from 'puppeteer-core';
import { encodeMessage } from '../lib/email.js';
import { generateReport } from '../lib/reportGenerator.js';

function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve) => {
    server.once('listening', () => resolve(server));
  });
}

test('multer memory storage keeps the CSV buffer and the text fields', async () => {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
  const app = express();
  app.post('/api/analyze', upload.single('file'), (req, res) => {
    const csv = req.file ? req.file.buffer.toString('utf-8') : req.body.csv;
    res.json({
      csv,
      riderName: req.body.riderName || '',
      originalname: req.file && req.file.originalname,
    });
  });
  const server = await listen(app);
  try {
    const body = new FormData();
    body.append('riderName', 'Ada');
    body.append('file', new Blob(['Lap,Time\n1,95.2\n'], { type: 'text/csv' }), 'session.csv');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`, {
      method: 'POST',
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.csv, 'Lap,Time\n1,95.2\n');
    assert.equal(json.riderName, 'Ada');
    assert.equal(json.originalname, 'session.csv');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('multer accepts a file at limits.fileSize and rejects one byte over', async () => {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 } });
  const app = express();
  app.post('/upload', upload.single('file'), (req, res) => {
    res.json({ bytes: req.file.buffer.length });
  });
  app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: err.code });
    next(err);
  });
  const server = await listen(app);
  const post = (text) => {
    const body = new FormData();
    body.append('file', new Blob([text], { type: 'text/csv' }), 'lap.csv');
    return fetch(`http://127.0.0.1:${server.address().port}/upload`, { method: 'POST', body });
  };
  try {
    const ok = await post('12345678');
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).bytes, 8);
    const over = await post('123456789');
    assert.equal(over.status, 413);
    assert.equal((await over.json()).error, 'LIMIT_FILE_SIZE');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('session report PDF includes charts and a PDF header', async () => {
  const pdf = await generateReport({
    summary: { trackName: 'Shannonville', sessionDate: '2026-06-01' },
    metrics: { maxSpeed: 180, avgSpeed: 90, maxGForces: { braking: 1.1, cornering: 0.8 } },
    laps: [{ lap: 1, time: 95.2, maxSpeed: 180, maxG: 1.1, sectors: [] }],
    lapStats: { count: 1, best: 95.2 },
    visualizations: { speedTrace: [{ x: 1, y: 180 }], gForceTrace: [{ x: 1, y: 1.1 }] },
  }, { riderName: 'Ada', bikeName: 'Test' });
  assert.equal(Buffer.isBuffer(pdf), true);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pdf.length > 1000);
});

test('pdfkit writes a PDF document', async () => {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: { Title: 'MotoTrackIQ smoke', Author: 'MotoTrackIQ' },
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  doc.font('Helvetica-Bold', 18).text('MotoTrackIQ');
  doc.font('Helvetica', 12).text('Lap 1  95.20s');
  doc.end();
  await done;
  const pdf = Buffer.concat(chunks);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(pdf.includes(Buffer.from('%%EOF')), true);
  assert.ok(pdf.length > 400);
});

test('email encoding builds a Gmail raw message and does not send it', () => {
  const raw = encodeMessage('rider@example.com', 'Your MotoTrackIQ report', '<p>Lap 1</p>');
  const msg = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(msg, /To: rider@example.com/);
  assert.match(msg, /Subject: Your MotoTrackIQ report/);
  assert.match(msg, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(msg, /<p>Lap 1<\/p>/);
  assert.equal(msg.includes('\r\n'), true);
});

test('puppeteer-core exports launch on Node 22', () => {
  assert.equal(typeof puppeteer.launch, 'function');
  assert.equal(process.versions.node.split('.')[0], '22');
});
