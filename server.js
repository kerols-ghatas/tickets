const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(__dirname));

// 1️⃣ تعريف المتغير أولاً ثم الاتصال بقاعدة البيانات
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ DB Connection Error:', err));

// تعريف شكل البيانات (Schema)
const BookingSchema = new mongoose.Schema({
    bookingId: String,
    name: String,
    phone: String,
    seats: [String],
    totalAmount: Number,
    status: { type: String, default: 'PENDING' },
    invoiceId: String,
    invoiceKey: String,
    createdAt: { type: Date, default: Date.now }
});
const Booking = mongoose.model('Booking', BookingSchema);

// المفاتيح
const FAWATERK_API_KEY = process.env.FAWATERK_API_KEY;
const FAWATERK_BASE_URL = "https://staging.fawaterk.com/api/v2";

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// 2️⃣ جلب المقاعد المحجوزة (اتدفعت فعليًا، أو لسه في مرحلة الدفع من أقل من 7 دقايق)
app.get('/api/booked-seats', async (req, res) => {
    try {
        // حجز مؤقت (Hold) لمدة 7 دقايق وقت الدفع، عشان نمنع اتنين يدفعوا على نفس الكرسي
        // لو الوقت عدى ومكملش الدفع، الكرسي بيرجع متاح تلقائيًا
        const sevenMinsAgo = new Date(Date.now() - 4 * 60 * 1000);
        const bookings = await Booking.find({
            $or: [
                { status: 'PAID' },
                { status: 'PENDING', createdAt: { $gte: sevenMinsAgo } }
            ]
        });
        const reservedSeats = [];
        bookings.forEach(b => { if (Array.isArray(b.seats)) reservedSeats.push(...b.seats); });
        res.json({ bookedSeats: [...new Set(reservedSeats)] });
    } catch (e) {
        console.error('❌ booked-seats error:', e.message);
        res.status(500).json({ bookedSeats: [] });
    }
});

// 3️⃣ إنشاء الفاتورة
app.post('/api/create-payment', async (req, res) => {
    try {
        const { name, phone, seats, totalAmount } = req.body;
        if (!name || !phone || !seats || !seats.length || !totalAmount) {
            return res.status(400).json({ success: false, message: 'بيانات غير مكتملة' });
        }

        // نتأكد إن مفيش حد سبقه ودفع فعلاً أو بيدفع دلوقتي (خلال آخر 7 دقايق) على نفس الكراسي دي
        const sevenMinsAgoCheck = new Date(Date.now() - 4 * 60 * 1000);
        const conflict = await Booking.findOne({
            seats: { $in: seats },
            $or: [
                { status: 'PAID' },
                { status: 'PENDING', createdAt: { $gte: sevenMinsAgoCheck } }
            ]
        });
        if (conflict) {
            return res.status(409).json({ success: false, message: 'للأسف تم حجز أحد الكراسي المختارة بالفعل، برجاء اختيار كرسي آخر' });
        }

        const bookingId = 'BK-' + Date.now();
        const host = req.get('host');
        const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
        const baseUrl = `${protocol}://${host}`;

        const nameParts = name.trim().split(' ');
        const payload = {
            payment_method_id: 2,
            cartTotal: String(totalAmount),
            currency: "EGP",
            customer: {
                first_name: nameParts[0] || "عميل",
                last_name: nameParts.slice(1).join(' ') || "حجز",
                email: `${bookingId.toLowerCase()}@booking.com`,
                phone: phone.trim()
            },
            redirectionUrls: {
                successUrl: `${baseUrl}/success.html?bookingId=${bookingId}`,
                failUrl: `${baseUrl}/cancel.html?bookingId=${bookingId}`,
                pendingUrl: `${baseUrl}/cancel.html?bookingId=${bookingId}`
            },
            webhookUrl: `${baseUrl}/api/payment-webhook`,
            cartItems: [{ name: `حجز مقاعد (${seats.join(', ')})`, price: String(totalAmount), quantity: "1" }]
        };

        const response = await axios.post(`${FAWATERK_BASE_URL}/invoiceInitPay`, payload, {
            headers: { 'Authorization': `Bearer ${FAWATERK_API_KEY.trim()}`, 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'success' && response.data?.data) {
            const { invoice_id, invoice_key, payment_data } = response.data.data;

            await Booking.create({
                bookingId, name, phone, seats, totalAmount,
                invoiceId: String(invoice_id), invoiceKey: invoice_key
            });

            if (payment_data?.redirectTo) {
                return res.json({ success: true, paymentUrl: payment_data.redirectTo });
            }
        }
        console.error('❌ Fawaterk invoiceInitPay unexpected response:', JSON.stringify(response.data));
        res.status(400).json({ success: false, message: 'فشل إنشاء فاتورة فواتيرك' });
    } catch (error) {
        console.error('❌ create-payment error:', error.response?.data || error.message);
        res.status(500).json({ success: false, message: 'حدث خطأ في السيرفر' });
    }
});

// دالة مساعدة: بتسأل فواتيرك أكتر من مرة قبل ما تقرر إن الدفع فشل
// لأن فواتيرك ممكن تاخد كام ثانية لغاية ما تسجل الدفع كـ paid فعليًا
async function checkFawaterkPaid(invoiceId, retries = 3, delayMs = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const fawaterkRes = await axios.get(`${FAWATERK_BASE_URL}/getInvoiceData/${invoiceId}`, {
                headers: {
                    'Authorization': `Bearer ${FAWATERK_API_KEY.trim()}`,
                    'Content-Type': 'application/json'
                }
            });
            const invoiceData = fawaterkRes.data?.data;
            if (invoiceData?.paid === 1) {
                return true;
            }
        } catch (err) {
            console.error(`❌ getInvoiceData attempt ${attempt} error:`, err.response?.data || err.message);
        }

        if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    return false;
}

// 4️⃣ التحقق من الحجز
app.get('/api/verify-booking', async (req, res) => {
    const { bookingId } = req.query;

    try {
        const booking = await Booking.findOne({ bookingId });

        if (!booking) return res.status(404).json({ status: 'failed', message: 'الحجز غير موجود' });

        // لو اتأكد PAID قبل كده مفيش داعي نسأل فواتيرك تاني
        // غير كده بنعيد التأكد دايمًا (بدل ما نتقفل على FAILED قديمة غلط بسبب تأخير فواتيرك)
        if (booking.status !== 'PAID' && booking.invoiceId) {
            const isPaid = await checkFawaterkPaid(booking.invoiceId);
            booking.status = isPaid ? 'PAID' : 'FAILED';
            await booking.save();
        }

        return res.json({
            status: booking.status === 'PAID' ? 'paid' : 'failed',
            name: booking.name, phone: booking.phone, seats: booking.seats
        });
    } catch (err) {
        console.error('❌ verify-booking error:', err.message);
        return res.status(500).json({ status: 'failed', message: 'حدث خطأ أثناء التحقق' });
    }
});

// 5️⃣ الـ Webhook
app.post('/api/payment-webhook', async (req, res) => {
    try {
        const { invoice_id, invoice_status } = req.body || {};
        console.log('📩 Webhook received:', req.body);
        if (invoice_id) {
            const isPaid = String(invoice_status).toLowerCase() === 'paid';
            await Booking.updateOne({ invoiceId: String(invoice_id) }, { status: isPaid ? 'PAID' : 'FAILED' });
        }
        return res.status(200).json({ message: 'تم الاستلام' });
    } catch (error) {
        console.error('❌ webhook error:', error.message);
        return res.status(200).json({ message: 'تم الاستلام' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
