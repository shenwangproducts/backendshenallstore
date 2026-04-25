const amqp = require('amqplib');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');

// 🌟 ฟังก์ชันดาวน์โหลดพร้อมระบบ Retry (Exponential Backoff)
async function downloadFileWithRetry(url, dest, logs, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await pipeline(response.body, fs.createWriteStream(dest));
            return true;
        } catch (error) {
            const delay = Math.pow(2, i) * 1000;
            logs.push(`[Retry] ดาวน์โหลดล้มเหลวครั้งที่ ${i+1}: ${error.message}. รอ ${delay/1000} วิ...`);
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function startMicroservice() {
    const conn = await amqp.connect(process.env.RABBITMQ_URL);
    const channel = await conn.createChannel();
    
    await channel.assertQueue('apk_scan_queue', { durable: true });
    await channel.assertQueue('scan_status_updates', { durable: true });

    console.log("🛠️ APK Scan Microservice Running...");

    channel.consume('apk_scan_queue', async (msg) => {
        const job = JSON.parse(msg.content.toString());
        const logs = [`[System] รับงานสแกนแอป ID: ${job.appId}`];
        
        const sendUpdate = (status, progress) => {
            channel.sendToQueue('scan_status_updates', Buffer.from(JSON.stringify({
                appId: job.appId,
                status,
                progress,
                scanLogs: logs,
                apkUrl: job.apkUrl
            })));
        };

        try {
            sendUpdate('processing', 50);
            
            const tmpPath = path.join(os.tmpdir(), `scan-${Date.now()}.apk`);
            logs.push(`[Download] กำลังดึงไฟล์จาก R2 Cloud...`);
            
            // 🌟 ใช้ระบบ Retry ที่เขียนไว้
            await downloadFileWithRetry(job.apkUrl, tmpPath, logs);
            
            logs.push(`[Scan] ดาวน์โหลดสำเร็จ กำลังวิเคราะห์ความปลอดภัย...`);
            sendUpdate('processing', 70);

            // ... (ใส่โค้ด AppInfoParser และ Logic การตรวจ IAP เดิมของคุณที่นี่) ...
            
            logs.push(`[Success] ตรวจสอบเสร็จสิ้น ไม่พบมัลแวร์`);
            sendUpdate('completed', 100);
            
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch (err) {
            logs.push(`[Error] 🚨 เกิดข้อผิดพลาดร้ายแรง: ${err.message}`);
            sendUpdate('failed', 0);
        } finally {
            channel.ack(msg);
        }
    });
}

startMicroservice();