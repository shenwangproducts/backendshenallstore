const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, getDocs } = require('firebase/firestore');
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

// ตั้งค่า Firebase Database
const firebaseConfig = {
    apiKey: "AIzaSyDbGswzP776ckZccnj72dkLMTNTD9ekMMQ",
    authDomain: "shenall.firebaseapp.com",
    projectId: "shenall",
    storageBucket: "shenall.firebasestorage.app",
    messagingSenderId: "879387934872",
    appId: "1:879387934872:web:43f9cfdcc62957657f90ed",
    measurementId: "G-2YTB1QC56E"
};

// เริ่มต้นเชื่อมต่อฐานข้อมูล
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

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
        const querySnapshot = await getDocs(collection(db, "apps"));
        const apps = [];
        querySnapshot.forEach((doc) => {
            apps.push({ id: doc.id, ...doc.data() });
        });
        res.json(apps);
    } catch (error) {
        console.error("Error fetching apps:", error);
        res.status(500).json({ error: 'Failed to fetch apps' });
    }
});

// 🌟 2. API สำหรับบันทึกแอปพลิเคชันใหม่เข้าฐานข้อมูล (POST)
app.post('/api/apps', async (req, res) => {
    try {
        const appData = req.body;
        // บันทึกลง Firestore ผ่าน Backend
        const docRef = await addDoc(collection(db, "apps"), appData);
        res.status(201).json({ success: true, id: docRef.id });
    } catch (error) {
        console.error("Error saving app:", error);
        res.status(500).json({ error: 'Failed to save app' });
    }
});

app.listen(port, () => {
    console.log(`Backend server running at http://localhost:${port}`);
});
