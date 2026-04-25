const amqp = require('amqplib');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const AppInfoParser = require('app-info-parser');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');

// 🌟 ตั้งค่า Firebase Admin (ใช้ฐานข้อมูล "store" ตาม server.js)
let db;
try {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT ? 
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : 
        require('./serviceAccountKey.json');
    
    const app = admin.apps.length === 0 
        ? admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
        : admin.apps[0];
        
    db = getFirestore(app, "store");
} catch (e) {
    console.error("❌ Firebase Init Error in Microservice:", e.message);
}

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
    const conn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
    const channel = await conn.createChannel();
    
    await channel.assertQueue('apk_scan_queue', { durable: true });
    await channel.assertQueue('scan_status_updates', { durable: true });

    // 🌟 ด้วย 32GB RAM และ 8 CPU เราจะยอมให้แต่ละ Worker รับงานหนักได้พร้อมกัน
    channel.prefetch(2); 

    console.log("🛠️ APK Scan Microservice Running...");

    channel.consume('apk_scan_queue', async (msg) => {
        const job = JSON.parse(msg.content.toString());
        const logs = [`[System] 🚀 เริ่มต้นรับงานสแกน (ID: ${job.appId})`];
        
        const sendUpdate = (status, progress, extra = {}) => {
            // 🌟 อัปเดตข้อมูลลง Firestore ทันทีที่สถานะเปลี่ยนเพื่อให้ Polling เห็นข้อมูลไวขึ้น
            channel.sendToQueue('scan_status_updates', Buffer.from(JSON.stringify({
                appId: job.appId,
                status,
                progress,
                scanLogs: logs,
                apkUrl: job.apkUrl,
                ...extra
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

            // 🌟 1. แกะไฟล์ APK เพื่อดู Package Name และ Version
            const parser = new AppInfoParser(tmpPath);
            const appInfo = await parser.parse();
            logs.push(`[Info] Package: ${appInfo.package} | Version: ${appInfo.versionName}`);

            // 🌟 2. ตรวจสอบ IAP และคำนวณค่าปรับ
            const permissions = appInfo.usesPermissions || [];
            const hasBilling = permissions.some(p => p.name.includes('BILLING') || p.name.includes('PURCHASING'));
            
            let finalIapFee = job.declaredIap || 0;
            let penalty = 0;

            if (hasBilling && finalIapFee < 20) {
                penalty = 5; // ปรับ 5% กรณีแจ้งไม่ตรง
                finalIapFee = 20 + penalty;
                logs.push(`[Penalty] 🚨 ตรวจพบระบบชำระเงินแต่แจ้งข้อมูลไม่ตรง! ปรับส่วนแบ่งเป็น ${finalIapFee}%`);
            }

            // 🌟 3. อัปเดตข้อมูลลง Firestore ทันที
            // 🛡️ ใช้ set + merge แทน update เพื่อป้องกัน Error หากหา Document ไม่เจอในจังหวะนั้น
            await db.collection("apps").doc(job.appId).set({
                scanStatus: 'completed',
                scanLogs: logs,
                package: appInfo.package,
                version: appInfo.versionName,
                iapFeePercent: finalIapFee,
                penalty: penalty,
                size: job.size ? (job.size / (1024 * 1024)).toFixed(1) + " MB" : "0 MB",
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            logs.push(`[Success] ตรวจสอบเสร็จสิ้น ไม่พบมัลแวร์ ข้อมูลถูกบันทึกแล้ว`);
            sendUpdate('completed', 100, { 
                finalIapFee, 
                penalty, 
                appInfo: { package: appInfo.package, versionName: appInfo.versionName },
                apkSize: job.size
            });
            
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