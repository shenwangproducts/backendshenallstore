# ใช้ Node.js เวอร์ชัน 18 (หรือเปลี่ยนเป็นเวอร์ชันที่คุณใช้)
FROM node:18-bullseye

# 🌟 อนุญาตให้เราติดตั้ง xdelta3 ได้แบบ 100%
RUN apt-get update && apt-get install -y xdelta3

# สร้างโฟลเดอร์สำหรับแอปพลิเคชันใน Docker
WORKDIR /usr/src/app

# คัดลอก package.json มาเพื่อติดตั้ง npm
COPY package*.json ./
RUN npm install

# คัดลอกโค้ดไฟล์ server.js และอื่นๆ ของเราเข้าไป
COPY . .

# สั่งให้รันเซิร์ฟเวอร์
CMD ["node", "server.js"]
