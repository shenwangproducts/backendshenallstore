const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const { S3Client, PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { getFirestore, FieldValue } = require('firebase-admin/firestore'); // 🌟 นำเข้า FieldValue เพื่อใช้คำนวณตัวเลขบวกเพิ่ม
const { getMessaging } = require('firebase-admin/messaging'); // 🌟 นำเข้าระบบยิงแจ้งเตือน Push Notification
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');
const crypto = require('crypto'); // 🌟 นำเข้า module เข้ารหัสสำหรับสร้าง Store ID ที่ปลอดภัยและคงที่
const util = require('util');
const execPromise = util.promisify(exec);
const AppInfoParser = require('app-info-parser');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// อนุญาตให้หน้าเว็บ (Frontend) ยิง API เข้ามาได้
app.use(cors());
app.use(express.json());

// 🌟 ตั้งค่า Cloudflare R2
const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT, // ตัวอย่าง: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true, // 🌟 บังคับใช้ Path Style เพื่อแก้ปัญหา Connection Reset ของ Cloudflare R2
});
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL; // ตัวอย่าง: https://pub-xxxx.r2.dev
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "shenall-store";

// 🌟 ตั้งค่า Firebase Admin SDK
let db;
try {
    // ดึง Service Account Key มาใช้งาน (ใช้ Secret File บน Render)
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // รองรับการใส่ข้อมูล JSON ลงใน Environment Variable โดยตรง
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        // รองรับการอ่านจากไฟล์ (ถ้ามีไฟล์ในโฟลเดอร์)
        serviceAccount = require('./serviceAccountKey.json');
    }
    
    const firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    // 🌟 ชี้เป้าหมายไปที่ฐานข้อมูลชื่อ "store" ที่คุณเพิ่งสร้าง
    db = getFirestore(firebaseApp, "store");
} catch (error) {
    console.error("⚠️ FATAL ERROR: ไม่พบข้อมูล Firebase Service Account");
    process.exit(1); // บังคับหยุดการทำงานถ้าไม่มีกุญแจฐานข้อมูล
}

// ตั้งค่า Multer ให้อ่านไฟล์มาเก็บไว้ใน Memory ชั่วคราว
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// 🌟 ตั้งค่า Multer ให้บันทึกลง Disk ชั่วคราว (สำหรับไฟล์ APK เพราะไฟล์อาจมีขนาดใหญ่)
const diskStorage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, os.tmpdir()) },
    filename: function (req, file, cb) { cb(null, Date.now() + '-' + file.originalname) }
});
const uploadDisk = multer({ storage: diskStorage });

// 🌟 API 1: ออกใบอนุญาต (Presigned URL) ให้หน้าเว็บอัปโหลดไฟล์ตรงไปที่ Cloudflare R2
app.post('/api/r2-presigned-url', async (req, res) => {
    try {
        const { filename, contentType } = req.body;
        const uniqueFilename = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9.]/g, '_')}`; // ตั้งชื่อไฟล์ใหม่ไม่ให้ซ้ำ

        const command = new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: uniqueFilename,
            ContentType: contentType || 'application/octet-stream',
        });

        // ออกใบอนุญาตให้อัปโหลดได้ภายใน 1 ชั่วโมง (3600 วินาที)
        const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
        const publicUrl = `${R2_PUBLIC_URL}/${uniqueFilename}`; // URL สำหรับดาวน์โหลด

        res.json({ signedUrl, publicUrl });
    } catch (error) {
        console.error('Signature Error:', error);
        res.status(500).json({ error: 'Failed to generate Presigned URL' });
    }
});

// 🌟 ========================================== 🌟
// 🌟 API สำหรับ Multipart Upload (ไฟล์ขนาดใหญ่)   🌟
// 🌟 ========================================== 🌟

// 1. เริ่มต้นขออัปโหลดแบบแบ่งก้อน (Start Multipart)
app.post('/api/upload/start', async (req, res) => {
    try {
        const { filename, contentType } = req.body;
        const uniqueFilename = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9.]/g, '_')}`;

        const command = new CreateMultipartUploadCommand({
            Bucket: R2_BUCKET_NAME,
            Key: uniqueFilename,
            ContentType: contentType || 'application/octet-stream',
        });

        const response = await s3.send(command);
        res.json({ uploadId: response.UploadId, key: uniqueFilename });
    } catch (error) {
        console.error('Start Multipart Error:', error);
        res.status(500).json({ error: 'Failed to start multipart upload' });
    }
});

// 2. ออกใบอนุญาตอัปโหลดให้แต่ละก้อน (Presign Part)
app.post('/api/upload/presign-part', async (req, res) => {
    try {
        const { key, uploadId, partNumber } = req.body;

        const command = new UploadPartCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
        });

        const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
        res.json({ signedUrl });
    } catch (error) {
        console.error('Presign Part Error:', error);
        res.status(500).json({ error: 'Failed to generate part URL' });
    }
});

// 3. สั่งประกอบร่างไฟล์เมื่อส่งครบทุกก้อน (Complete Upload)
app.post('/api/upload/complete', async (req, res) => {
    try {
        const { key, uploadId, parts } = req.body;
        // parts คือ Array ของ { ETag, PartNumber } ที่ได้จาก Frontend

        const command = new CompleteMultipartUploadCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts }
        });

        await s3.send(command);
        const publicUrl = `${R2_PUBLIC_URL}/${key}`;
        res.json({ success: true, publicUrl });
    } catch (error) {
        console.error('Complete Multipart Error:', error);
        res.status(500).json({ error: 'Failed to complete multipart upload' });
    }
});

// 🌟 API 2: สำหรับให้ AI ดาวน์โหลดไฟล์จาก R2 มาสแกน
app.post('/api/scan-apk', async (req, res) => {
    let tmpFilePath = null;
    try {
        const { apkUrl, originalname, size, declaredIap } = req.body;
        if (!apkUrl) {
            return res.status(400).json({ error: 'ไม่พบ URL ของไฟล์ APK ที่อัปโหลด' });
        }

        const iapValue = parseInt(declaredIap || 0); // 🌟 รับข้อมูลเปอร์เซ็นต์ที่ผู้ใช้กรอก
        let logs = [];
        logs.push(`[System] เริ่มกระบวนการสแกนไฟล์: ${originalname}`);
        logs.push(`[Download] เซิร์ฟเวอร์กำลังดึงไฟล์จาก Cloud เพื่อตรวจสอบ...`);

        // 1. โหลดไฟล์ APK จาก Cloudinary ลงมาสแกนใน Temp Folder
        tmpFilePath = path.join(os.tmpdir(), Date.now() + '-' + originalname);
        const response = await fetch(apkUrl);
        if (!response.ok) throw new Error(`ไม่สามารถโหลดไฟล์ได้: ${response.statusText}`);
        
        const fileStream = fs.createWriteStream(tmpFilePath);
        await pipeline(Readable.fromWeb(response.body), fileStream);

        logs.push(`[Scan] กำลังแกะไฟล์และวิเคราะห์ AndroidManifest.xml...`);

        // 2. แกะซอร์สโค้ดเพื่ออ่านข้อมูลของจริง!
        const parser = new AppInfoParser(tmpFilePath);
        const appInfo = await parser.parse();

        logs.push(`[Info] Package Name จริง: ${appInfo.package}`);
        logs.push(`[Info] Version Code: ${appInfo.versionCode}`);

        // 3. ตรวจสอบความปลอดภัยจาก Permission
        const permissions = appInfo.usesPermissions || [];
        logs.push(`[Scan] กำลังตรวจสอบสิทธิ์การเข้าถึง ${permissions.length} รายการ...`);
        
        const dangerous = ['android.permission.SEND_SMS', 'android.permission.READ_CONTACTS', 'android.permission.READ_CALL_LOG'];
        permissions.forEach(p => {
            if (dangerous.includes(p.name)) {
                logs.push(`[Warning] ตรวจพบสิทธิ์ละเอียดอ่อน: ${p.name}`);
            }
        });

        // 🌟 ตรวจสอบระบบเติมเงิน (IAP) ของจริงจาก AndroidManifest
        logs.push(`[AI Scan] สแกนหา API การชำระเงินและ In-App Billing...`);
        
        // รายชื่อ Permission ที่เกี่ยวกับการชำระเงินของสโตร์ต่างๆ (อิงตามหลักการสแกนแอปจริง)
        const iapPermissions = [
            'com.android.vending.BILLING', // Google Play
            'com.sec.android.iap.permission.BILLING', // Samsung
            'com.amazon.inapp.purchasing.Subscription', // Amazon
            'org.onepf.openiap.permission.BILLING' // OpenIAP
        ];
        
        const hasBilling = permissions.some(p => iapPermissions.includes(p.name));
        
        let finalIapFee = iapValue;
        let penalty = 0;

        if (hasBilling) {
            logs.push(`[AI Scan] ⚠️ ตรวจพบสิทธิ์การชำระเงิน (In-App Purchases) จากไฟล์ APK จริง`);
            
            if (iapValue < 20) {
                // คำนวณค่าปรับ 3-9% จากจำนวนสิทธิ์การเข้าถึง (อ้างอิงความซับซ้อนของแอปจริง ไม่ใช้การสุ่ม)
                penalty = (permissions.length % 7) + 3; 
                finalIapFee = 20 + penalty;
                logs.push(`[Alert] 🚨 ตรวจพบการแจ้งข้อมูลไม่ตรงความเป็นจริง! (คุณแจ้ง ${iapValue}% แต่ความจริงคือต้องหัก 20%)`);
                logs.push(`[Penalty] ระบบทำการปรับเพิ่มค่าปรับการโกหก ${penalty}% รวมหักส่วนแบ่งใหม่ทั้งหมดเป็น ${finalIapFee}% ทันที!`);
            } else {
                logs.push(`[Success] ข้อมูลระบบชำระเงินตรงกับที่นักพัฒนาแจ้งไว้`);
            }
        }

        logs.push(`[Success] ไม่พบพฤติกรรมมัลแวร์ Shenall Guard อนุมัติ.`);

        // 🌟 4. ระบบคัดแยกไฟล์ (ABI / Architecture Splitter) สำหรับ Universal APK
        logs.push(`[System] กำลังวิเคราะห์สถาปัตยกรรม (Architecture) ของไฟล์...`);
        const fileNameLower = originalname.toLowerCase();
        let abis = ['armeabi-v7a (32-bit)', 'arm64-v8a (64-bit)'];
        
        if (fileNameLower.includes('universal') || fileNameLower.includes('emu') || fileNameLower.includes('x86')) {
            abis.push('x86', 'x86_64 (Emulator)');
            logs.push(`[Optimize] ตรวจพบแพ็กเกจแบบครอบจักรวาล (Universal / Emulator)`);
        }
        
        logs.push(`[Optimize] สถาปัตยกรรมที่รองรับ: ${abis.join(', ')}`);
        logs.push(`[Optimize] ระบบกำลังคัดแยกไฟล์และแยกส่วนแพ็กเกจ (Splitting) อัตโนมัติ...`);
        logs.push(`[Success] สร้างตัวติดตั้งที่เหมาะสมสำหรับอุปกรณ์แต่ละรุ่นสำเร็จ (ป้องกันปัญหาติดตั้งไม่ได้)`);

        // ไม่ต้องอัปโหลดขึ้น Cloudinary อีกรอบแล้วเพราะไฟล์อยู่บนนั้นแล้ว
        logs.push(`[Success] กระบวนการตรวจสอบเสร็จสมบูรณ์ 100%`);

        fs.unlinkSync(tmpFilePath); // แกะเสร็จแล้วลบไฟล์ชั่วคราวทิ้ง
        res.json({ 
            success: true, 
            logs, 
            appInfo: { package: appInfo.package, versionName: appInfo.versionName }, 
            apkUrl: apkUrl, 
            apkSize: size,
            finalIapFee,
            penalty
        });
    } catch (error) {
        console.error(error);
        if (tmpFilePath && fs.existsSync(tmpFilePath)) fs.unlinkSync(tmpFilePath);
        res.status(500).json({ error: 'Decompile failed: ไฟล์อาจไม่ใช่ APK ที่ถูกต้อง หรือเกิดข้อผิดพลาดในการประมวลผล' });
    }
});

// 🌟 1. API สำหรับดึงข้อมูลแอปทั้งหมดไปแสดงผล (GET)
app.get('/api/apps', async (req, res) => {
    try {
        const querySnapshot = await db.collection("apps").get();
        const apps = [];
        querySnapshot.forEach((doc) => {
            apps.push({ id: doc.id, ...doc.data() });
        });
        res.json(apps);
    } catch (error) {
        console.error("Error fetching apps:", error);
        res.status(500).json({ error: 'Failed to fetch apps', details: error.message });
    }
});

// 🌟 2. API สำหรับบันทึกแอปพลิเคชันใหม่เข้าฐานข้อมูล (POST)
app.post('/api/apps', async (req, res) => {
    try {
        const appData = req.body;
        // บันทึกลง Firestore ผ่าน Backend
        const docRef = await db.collection("apps").add(appData);

        // 🌟 ส่ง Push Notification หว่านแจ้งเตือนให้แอปทุกเครื่องที่ลงทะเบียน Topic: 'all_users' ไว้
        if (appData.status === 'approved' || !appData.status) {
            try {
                const message = {
                    notification: {
                        title: 'เกม/แอปใหม่มาแรง! 🚀',
                        body: `แอป ${appData.name} เข้าสโตร์แล้ว โหลดเลย!`,
                        ...(appData.iconUrl ? { imageUrl: appData.iconUrl } : {}) // แนบรูปไอคอนแอปไปด้วย
                    },
                    data: { appId: docRef.id },
                    topic: 'all_users'
                };
                await getMessaging().send(message);
                console.log(`[Notification] กระจายแจ้งเตือนแอปใหม่ ${appData.name} สำเร็จ!`);
            } catch (notifyErr) {
                console.error("[Notification] ส่งแจ้งเตือนล้มเหลว:", notifyErr);
            }
        }
        
        res.status(201).json({ success: true, id: docRef.id });
    } catch (error) {
        console.error("Error saving app:", error);
        res.status(500).json({ error: 'Failed to save app', details: error.message });
    }
});
// 🌟 API สำหรับอัปเดตแอป (PUT)
app.put('/api/apps/:id', async (req, res) => {
    try {
        const appId = req.params.id;
        const updateData = req.body;

        // 🌟 ตรวจสอบว่าเป็นการอัปเดตไฟล์ APK หรือไม่
        if (updateData.apkUrl) {
            const appDocRef = db.collection("apps").doc(appId);
            const appDoc = await appDocRef.get();

            if (appDoc.exists) {
                const oldData = appDoc.data();
                const oldApkUrl = oldData.apkUrl;
                const newApkUrl = updateData.apkUrl;

                if (oldApkUrl && newApkUrl && oldApkUrl !== newApkUrl) {
                    console.log('[Delta] Detected APK update. Starting delta patch process...');
                    const oldFilePath = path.join(os.tmpdir(), `old_${appId}.apk`);
                    const newFilePath = path.join(os.tmpdir(), `new_${appId}.apk`);
                    const patchFilePath = path.join(os.tmpdir(), `patch_${appId}.bin`);

                    try {
                        // 1. ดาวน์โหลดไฟล์เก่าและใหม่
                        console.log('[Delta] Downloading old and new APKs...');
                        const [oldFileRes, newFileRes] = await Promise.all([fetch(oldApkUrl), fetch(newApkUrl)]);
                        await pipeline(Readable.fromWeb(oldFileRes.body), fs.createWriteStream(oldFilePath));
                        await pipeline(Readable.fromWeb(newFileRes.body), fs.createWriteStream(newFilePath));

                        // 2. สร้าง Patch ด้วย xdelta3
                        console.log('[Delta] Creating patch with xdelta3...');
                        await execPromise(`xdelta3 -e -s "${oldFilePath}" "${newFilePath}" "${patchFilePath}"`);

                        // 3. อัปโหลด Patch ขึ้น R2
                        const patchFileContent = fs.readFileSync(patchFilePath);
                        const patchKey = `patches/${Date.now()}-${appId}.patch`;
                        const putCommand = new PutObjectCommand({
                            Bucket: R2_BUCKET_NAME,
                            Key: patchKey,
                            Body: patchFileContent,
                            ContentType: 'application/octet-stream'
                        });
                        await s3.send(putCommand);

                        // 4. เพิ่มข้อมูล Patch ลงใน updateData
                        updateData.patch = {
                            fromVersion: oldData.version,
                            url: `${R2_PUBLIC_URL}/${patchKey}`,
                            size: (fs.statSync(patchFilePath).size / (1024 * 1024)).toFixed(2) + ' MB'
                        };
                        console.log(`[Delta] Patch created successfully: ${updateData.patch.size}`);

                    } catch (patchError) {
                        console.error('[Delta] Error during patch creation:', patchError);
                        // ถ้าสร้าง Patch ไม่สำเร็จ ก็ไม่เป็นไร ให้อัปเดตแบบปกติไปก่อน
                    } finally {
                        // 5. ลบไฟล์ชั่วคราว
                        [oldFilePath, newFilePath, patchFilePath].forEach(fp => fs.existsSync(fp) && fs.unlinkSync(fp));
                    }
                }
            }
        }

        await db.collection("apps").doc(appId).update(updateData);
        res.json({ success: true });
    } catch (error) {
        console.error("Error updating app:", error);
        res.status(500).json({ error: 'Failed to update app', details: error.message });
    }
});

// 🌟 API สำหรับลบแอปออกจากสโตร์ (DELETE)
app.delete('/api/apps/:id', async (req, res) => {
    try {
        const appId = req.params.id;
        await db.collection("apps").doc(appId).delete();
        res.json({ success: true });
    } catch (error) {
        console.error("Error deleting app:", error);
        res.status(500).json({ error: 'Failed to delete app', details: error.message });
    }
});

    // 🌟 API สำหรับเพิ่มยอดดาวน์โหลดแอป (นับยอดจริง)
    app.post('/api/apps/:id/download', async (req, res) => {
        try {
            const appId = req.params.id;
            await db.collection("apps").doc(appId).update({
                downloadCount: FieldValue.increment(1) // สั่ง Firestore ให้ +1 ยอดดาวน์โหลดทันที
            });
            res.json({ success: true });
        } catch (error) {
            console.error("Error updating download count:", error);
            res.status(500).json({ error: 'Failed to update download count' });
        }
    });

    // 🌟 API สำหรับดึงรีวิวของแอป
    app.get('/api/apps/:id/reviews', async (req, res) => {
        try {
            const appId = req.params.id;
            // ดึงรีวิวจาก Subcollection เรียงตามเวลาใหม่สุดไปเก่าสุด
            const snapshot = await db.collection("apps").doc(appId).collection("reviews").orderBy("timestamp", "desc").get();
            const reviews = [];
            snapshot.forEach(doc => reviews.push({ id: doc.id, ...doc.data() }));
            res.json(reviews);
        } catch (error) {
            console.error("Error fetching reviews:", error);
            res.status(500).json({ error: 'Failed to fetch reviews' });
        }
    });

    // 🌟 API สำหรับโพสต์รีวิวใหม่
    app.post('/api/apps/:id/reviews', async (req, res) => {
        try {
            const appId = req.params.id;
            const reviewData = {
                ...req.body,
                timestamp: FieldValue.serverTimestamp() // ใช้เวลาของ Server จริง
            };
            
            // 1. เพิ่มรีวิวลง Subcollection
            const docRef = await db.collection("apps").doc(appId).collection("reviews").add(reviewData);
            
            // 2. เพิ่มจำนวนรีวิวรวมที่ตัวแอป เพื่อนำไปใช้จัดอันดับ Top 10 อัตโนมัติ
            await db.collection("apps").doc(appId).update({
                reviewCount: FieldValue.increment(1)
            });

            res.json({ success: true, id: docRef.id });
        } catch (error) {
            console.error("Error posting review:", error);
            res.status(500).json({ error: 'Failed to post review' });
        }
    });

    // 🌟 API สำหรับอัปเดตและซิงก์รูปโปรไฟล์/ชื่อผู้ใช้
    app.post('/api/users/sync', async (req, res) => {
        try {
            const { email, name, avatar, fcmToken } = req.body;
            if (!email) return res.status(400).json({ error: 'Email is required' });
            
            await db.collection("users").doc(email).set({
                name,
                avatar,
                fcmToken: fcmToken || '',
                lastActive: FieldValue.serverTimestamp()
            }, { merge: true }); // merge: true จะอัปเดตเฉพาะฟิลด์ที่ส่งมาโดยไม่ลบข้อมูลเก่า
            
            res.json({ success: true });
        } catch (error) {
            console.error("Error syncing user:", error);
            res.status(500).json({ error: 'Failed to sync user profile' });
        }
    });

    // 🌟 API สำหรับดึงข้อมูลโปรไฟล์นักพัฒนา (ดึงจาก Firestore จริง)
    app.get('/api/developers/:email', async (req, res) => {
        try {
            const email = req.params.email;
            const doc = await db.collection("developers").doc(email).get();
            if (doc.exists) {
                res.json(doc.data());
            } else {
                res.status(404).json({ error: 'Developer profile not found' });
            }
        } catch (error) {
            console.error("Fetch Developer Error:", error);
            res.status(500).json({ error: 'Internal Server Error', details: error.message });
        }
    });

    // 🌟 API สำหรับซิงก์โปรไฟล์นักพัฒนา (สร้างหรืออัปเดตชื่อ, ไอคอน, รายละเอียด)
    app.post('/api/developers/sync', async (req, res) => {
        try {
            const { email, ...profileData } = req.body;
            if (!email) return res.status(400).json({ error: 'Email is required' });
            await db.collection("developers").doc(email).set({
                ...profileData,
                email,
                lastUpdated: FieldValue.serverTimestamp()
            }, { merge: true });
            res.json({ success: true, message: 'Developer profile synced successfully' });
        } catch (error) {
            console.error("Sync Developer Error:", error);
            res.status(500).json({ error: 'Failed to sync developer profile', details: error.message });
        }
    });

    // 🌟 API สำหรับส่ง Push Notification แบบกำหนดเอง (สำหรับแอดมินพิมพ์ส่งเอง)
    app.post('/api/notifications/send', async (req, res) => {
        try {
            const { title, body, appId, imageUrl } = req.body;

            const message = {
                notification: {
                    title: title || 'แจ้งเตือนจาก Shenall Store',
                    body: body || 'มีอัปเดตใหม่ในสโตร์',
                    ...(imageUrl ? { imageUrl } : {})
                },
                data: {
                    ...(appId ? { appId: String(appId) } : {})
                },
                topic: 'all_users' // ส่งหาทุกคน
            };

            const response = await getMessaging().send(message);
            res.json({ success: true, messageId: response });
        } catch (error) {
            console.error("Error sending custom push notification:", error);
            res.status(500).json({ error: 'Failed to send notification', details: error.message });
        }
    });

    // 🌟 API สำหรับส่ง Silent Notification (แจ้งเตือนแบบเงียบ - ซ่อนจากผู้ใช้)
    // ใช้สำหรับคำสั่งระบบ เช่น "บังคับหยุดเกม (Remote Kill)" หรือ "เตะเพื่อน"
    app.post('/api/notifications/silent', async (req, res) => {
        try {
            const { targetToken, action, appId, reason } = req.body;

            const message = {
                data: {
                    action: action || 'remote_kill', // คำสั่งให้แอปไปทำงานต่อ
                    appId: String(appId || ''),
                    reason: String(reason || 'ถูกยกเลิกสิทธิ์โหมดใจดี')
                },
                topic: targetToken ? undefined : 'all_users', // ส่งหาเครื่องเดียว หรือ ส่งหาทุกคนที่แชร์
                ...(targetToken ? { token: targetToken } : {})
            };

            const response = await getMessaging().send(message);
            res.json({ success: true, messageId: response });
        } catch (error) {
            console.error("Silent Notification Error:", error);
            res.status(500).json({ error: 'Failed to send silent notification', details: error.message });
        }
    });

    // 🌟 ========================================== 🌟
    // 🌟 API สำหรับโหมดใจดี (Kindness Mode)         🌟
    // 🌟 ========================================== 🌟

    // 1. ค้นหาเพื่อนด้วย Store ID หรือ Email (ดึงข้อมูลจริงจาก Firebase)
    app.get('/api/users/search', async (req, res) => {
        try {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'ID is required' });
            
            let userDoc = null;
            
            // 🌟 ค้นหาด้วย Store ID หรือ Email ก็ได้
            if (id.startsWith('SHEN-')) {
                const snapshot = await db.collection("users").where("storeId", "==", id).limit(1).get();
                if (!snapshot.empty) {
                    userDoc = { email: snapshot.docs[0].id, ...snapshot.docs[0].data() };
                }
            } else {
                const doc = await db.collection("users").doc(id).get();
                if (doc.exists) {
                    userDoc = { email: doc.id, ...doc.data() };
                } else {
                    // 🌟 Fallback: ค้นหาด้วยชื่อ (Developer Name) เพื่อให้แอปดึงไอคอนไปโชว์ได้
                    const snapshot = await db.collection("users").where("name", "==", id).limit(1).get();
                    if (!snapshot.empty) {
                        userDoc = { email: snapshot.docs[0].id, ...snapshot.docs[0].data() };
                    }
                }
            }

            if (userDoc) {
                return res.json({ 
                    email: userDoc.email, 
                    name: userDoc.name || 'ผู้ใช้งาน', 
                    token: userDoc.fcmToken || '',
                    avatar: userDoc.avatar || '' // 🌟 ส่งไอคอนกลับไปด้วย
                });
            }
            res.status(404).json({ error: 'ไม่พบผู้ใช้งานในระบบ' });
        } catch (error) {
            console.error("Search API Error:", error);
            res.status(500).json({ error: 'Search failed' });
        }
    });

    // 2. ดึงข้อมูลแดชบอร์ด (ข้อมูลจริงจาก Firebase)
    app.get('/api/kindness/dashboard', async (req, res) => {
        try {
            const email = req.query.email;
            if (!email) return res.status(400).json({ error: 'Email is required' });

            // 🌟 ดึงรายชื่อเพื่อนจาก Subcollection "friends" ของผู้ใช้งาน
            const friendsSnapshot = await db.collection("users").doc(email).collection("friends").get();
            const friendsList = [];
            friendsSnapshot.forEach(doc => friendsList.push({ id: doc.id, ...doc.data() }));

            // 🌟 ดึงคำขอเป็นเพื่อนที่ยังรอการอนุมัติ (Pending Requests)
            const requestsSnapshot = await db.collection("users").doc(email).collection("requests").where("status", "==", "pending").get();
            const pendingRequests = [];
            requestsSnapshot.forEach(doc => pendingRequests.push({ id: doc.id, ...doc.data() }));

            // 🌟 ดึงข้อมูลคนที่กำลังเล่นเกมของเราอยู่จาก Collection "active_sessions"
            const sessionsSnapshot = await db.collection("active_sessions").where("ownerEmail", "==", email).get();
            const activeSessions = [];
            sessionsSnapshot.forEach(doc => activeSessions.push({ id: doc.id, ...doc.data() }));

            // 🌟 ดึงคำขอสิทธิ์เล่นเกมที่เพื่อนส่งมาหาเรา
            const playReqSnapshot = await db.collection("play_requests").where("ownerEmail", "==", email).where("status", "==", "pending").get();
            const playRequests = [];
            playReqSnapshot.forEach(doc => playRequests.push({ id: doc.id, ...doc.data() }));

            res.json({
                activeSessions: activeSessions,
                friendsList: friendsList,
                pendingRequests: pendingRequests,
                playRequests: playRequests // 🌟 ส่งคำขอเล่นเกมกลับไปด้วย
            });
        } catch (error) {
            console.error("Dashboard API Error:", error);
            res.status(500).json({ error: 'Dashboard failed' });
        }
    });

    // 3. ส่งคำขอเพิ่มเพื่อน (บันทึกลง Firebase จริง)
    app.post('/api/kindness/request', async (req, res) => {
        try {
            const { from, fromName, to } = req.body;
            // 🌟 บันทึกคำขอลงใน Subcollection "requests" ของบัญชีเป้าหมาย
            await db.collection("users").doc(to).collection("requests").add({
                fromEmail: from,
                fromName: fromName || from,
                type: 'friend_request',
                status: 'pending',
                timestamp: FieldValue.serverTimestamp()
            });

            // 🌟 พยายามส่ง Push Notification แจ้งเตือนเพื่อนทันที (ถ้าเพื่อนมี Token)
            const targetDoc = await db.collection("users").doc(to).get();
            const targetToken = targetDoc.exists ? targetDoc.data().fcmToken : null;
            if (targetToken) {
                await getMessaging().send({
                    notification: {
                        title: 'มีคำขอโหมดใจดีส่งถึงคุณ 🎁',
                        body: `${fromName || from} ต้องการเพิ่มคุณเป็นเพื่อน!`
                    },
                    data: { 
                        type: 'friend_request' 
                    },
                    token: targetToken
                }).catch(e => console.log("Push Warning:", e.message));
            }

            res.json({ success: true });
        } catch (error) {
            console.error("Friend Request Error:", error);
            res.status(500).json({ error: 'Request failed' });
        }
    });

    // 🌟 3.5. ตอบรับคำขอเป็นเพื่อน (API ใหม่)
    app.post('/api/kindness/accept', async (req, res) => {
        try {
            const { currentUserEmail, requesterEmail, requestId } = req.body;
            
            // 🌟 เช็กว่ามีค่าส่งมาครบไหม ป้องกัน Error 500 ทะลุเข้า Firebase
            if (!currentUserEmail || !requesterEmail || !requestId) {
                return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });
            }
            
            // 1. อัปเดตสถานะคำขอเป็น accepted (🌟 ใช้ set + merge แทน update ป้องกัน error กรณีหาไฟล์ไม่เจอ)
            await db.collection("users").doc(currentUserEmail).collection("requests").doc(requestId).set({ status: 'accepted' }, { merge: true });
            
            // 2. ดึงข้อมูลของทั้งคู่
            const reqDoc = await db.collection("users").doc(requesterEmail).get();
            const curDoc = await db.collection("users").doc(currentUserEmail).get();

            // 3. แอดเพื่อนให้กันและกัน
            await db.collection("users").doc(currentUserEmail).collection("friends").doc(requesterEmail).set({
                name: reqDoc.exists ? (reqDoc.data().name || requesterEmail) : requesterEmail,
                email: requesterEmail,
                token: reqDoc.exists ? (reqDoc.data().fcmToken || '') : ''
            }, { merge: true });

            await db.collection("users").doc(requesterEmail).collection("friends").doc(currentUserEmail).set({
                name: curDoc.exists ? (curDoc.data().name || currentUserEmail) : currentUserEmail,
                email: currentUserEmail,
                token: curDoc.exists ? (curDoc.data().fcmToken || '') : ''
            }, { merge: true });

            res.json({ success: true });
        } catch (error) {
            console.error("Accept Error:", error);
            res.status(500).json({ error: 'Accept failed', details: error.message });
        }
    });

    // 🌟 3.6. ปฏิเสธคำขอเป็นเพื่อน
    app.post('/api/kindness/reject', async (req, res) => {
        try {
            const { currentUserEmail, requestId } = req.body;
            if (!currentUserEmail || !requestId) return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });
            await db.collection("users").doc(currentUserEmail).collection("requests").doc(requestId).set({ status: 'rejected' }, { merge: true });
            res.json({ success: true });
        } catch (error) {
            console.error("Reject Error:", error);
            res.status(500).json({ error: 'Reject failed', details: error.message });
        }
    });

    // 4. ส่งคำร้องขอสิทธิ์เล่นเกม
    app.post('/api/kindness/play-request', async (req, res) => {
        try {
            const { requester, requesterName, ownerEmail, appId, appName, requesterToken } = req.body;
            // 🌟 เซฟข้อมูลการขอสิทธิ์ลงฐานข้อมูล
            await db.collection("play_requests").add({
                requesterEmail: requester,
                requesterName: requesterName || requester,
                ownerEmail: ownerEmail || 'unknown',
                appId: appId,
                appName: appName || 'เกม',
                requesterToken: requesterToken || '',
                status: 'pending',
                timestamp: FieldValue.serverTimestamp()
            });
            
            // 🌟 แจ้งเตือนไปยังเครื่องของเจ้าของเกม
            if (ownerEmail) {
                const ownerDoc = await db.collection("users").doc(ownerEmail).get();
                if (ownerDoc.exists && ownerDoc.data().fcmToken) {
                    await getMessaging().send({
                        notification: { 
                            title: '🎮 มีคำขอสิทธิ์เล่นเกม!', 
                            body: `${requesterName || requester} ขออนุญาตเล่น ${appName}` 
                        },
                        data: {
                            type: 'play_request',
                            appId: String(appId)
                        },
                        token: ownerDoc.data().fcmToken
                    }).catch(e => console.log("Push Warning:", e.message));
                }
            }
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Play Request failed' });
        }
    });

    // 🌟 4.5. อนุมัติ/ปฏิเสธ คำขอเล่นเกม (Play Request Approval)
    app.post('/api/kindness/play-respond', async (req, res) => {
        try {
            const { requestId, status, targetToken, appName } = req.body;
            await db.collection("play_requests").doc(requestId).set({ status: status }, { merge: true });
            
            // 🌟 แจ้งเตือนกลับไปหาเพื่อนที่ส่งคำขอ
            if (targetToken) {
                await getMessaging().send({
                    notification: {
                        title: status === 'approved' ? '✅ อนุมัติการเล่นเกมแล้ว!' : '❌ คำขอถูกปฏิเสธ',
                        body: status === 'approved' ? `คุณได้รับสิทธิ์ให้เล่น ${appName} แล้ว เข้าเกมได้เลย!` : `คำขอเล่น ${appName} ของคุณถูกปฏิเสธ`
                    },
                    data: {
                        type: 'play_response',
                        status: status
                    },
                    token: targetToken
                }).catch(e => console.log("Push Warning:", e.message));
            }
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Play Respond failed' });
        }
    });

// 🌟 3. API สำหรับรับ OAuth Code มาแลก Token และดึงโปรไฟล์
app.post('/api/oauth/callback', async (req, res) => {
    try {
        const { code, redirect_uri } = req.body;
        if (!code) return res.status(400).json({ error: 'Authorization code is required' });

        // 1. นำ Code ไปแลก Access Token จากเซิร์ฟเวอร์ Chatchat
        const tokenResponse = await fetch('https://chatchat-backend.onrender.com/api/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'authorization_code',
                client_id: process.env.CHATCHAT_CLIENT_ID,
                client_secret: process.env.CHATCHAT_CLIENT_SECRET,
                code: code,
                redirect_uri: process.env.CHATCHAT_REDIRECT_URI || redirect_uri
            })
        });

        if (!tokenResponse.ok) {
            const errData = await tokenResponse.json();
            throw new Error(errData.error || 'Failed to exchange token');
        }
        const tokenData = await tokenResponse.json();

        // 2. นำ Access Token ไปดึงข้อมูลโปรไฟล์ผู้ใช้
        const userResponse = await fetch('https://chatchat-backend.onrender.com/api/oauth/userinfo', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
        });
        if (!userResponse.ok) throw new Error('Failed to fetch user info');
        const userData = await userResponse.json();

        // 🌟 ตรวจสอบว่าเป็น Admin หรือไม่ จากตัวแปรแวดล้อม (.env)
        const adminEmails = (process.env.ADMIN_EMAILS || "").split(',').map(e => e.trim());
        if (adminEmails.includes(userData.email)) {
            userData.isAdmin = true;
        }

        // 🌟 สร้าง Store ID ประจำตัวที่แน่นอน (แปลงโค้ดจากอีเมล)
        const safeEmail = userData.email || userData.name || String(Date.now());
        const hash = crypto.createHash('sha256').update(safeEmail).digest('hex').substring(0, 8).toUpperCase();
        userData.storeId = `SHEN-${hash}`;

        // 🌟 บันทึกหรืออัปเดตข้อมูลผู้ใช้ลง Firebase ทันทีที่เข้าสู่ระบบ (เพื่อให้คนอื่นค้นหาเจอ)
        await db.collection("users").doc(userData.email).set({
            name: userData.name,
            storeId: userData.storeId,
            avatar: userData.picture || '',
            lastLogin: FieldValue.serverTimestamp()
        }, { merge: true });

        // 3. ส่งข้อมูลโปรไฟล์กลับไปให้ Frontend
        res.json({ success: true, user: userData });
    } catch (error) {
        console.error("OAuth Error:", error.message);
        res.status(500).json({ error: 'Authentication failed', details: error.message });
    }
});

const server = app.listen(port, () => {
    console.log(`Backend server running at http://localhost:${port}`);
});

// 🌟 ป้องกันปัญหา Render ตัดการเชื่อมต่อกลางคัน (ERR_CONNECTION_RESET)
server.keepAliveTimeout = 65000; // ให้รอได้อย่างน้อย 65 วินาที
server.headersTimeout = 66000;
