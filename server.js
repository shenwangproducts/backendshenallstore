const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// อนุญาตให้หน้าเว็บ (Frontend) ยิง API เข้ามาได้
app.use(cors());
app.use(express.json());

// ตั้งค่า Cloudinary จากไฟล์ .env
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// 🌟 ตั้งค่า Firebase Admin SDK
let db;
try {
    // ดึง Service Account Key มาใช้งาน (ใช้ Secret File บน Render)
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
} catch (error) {
    console.error("⚠️ FATAL ERROR: ไม่พบไฟล์ serviceAccountKey.json ในระบบของ Render");
    process.exit(1); // บังคับหยุดการทำงานถ้าไม่มีกุญแจฐานข้อมูล
}

// ตั้งค่า Multer ให้อ่านไฟล์มาเก็บไว้ใน Memory ชั่วคราว
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// API สำหรับรับไฟล์และอัปโหลดขึ้น Cloudinary
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const resourceType = req.body.resourceType || 'auto';
        // สร้าง Buffer ของไฟล์ให้กลายเป็น Base64 เพื่อส่งให้ Cloudinary
        const b64 = Buffer.from(req.file.buffer).toString('base64');
        let dataURI = "data:" + req.file.mimetype + ";base64," + b64;
        
        const result = await cloudinary.uploader.upload(dataURI, {
            resource_type: resourceType
        });
        
        res.json({ url: result.secure_url });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Upload failed' });
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
        res.status(201).json({ success: true, id: docRef.id });
    } catch (error) {
        console.error("Error saving app:", error);
        res.status(500).json({ error: 'Failed to save app', details: error.message });
    }
});

app.listen(port, () => {
    console.log(`Backend server running at http://localhost:${port}`);
});
