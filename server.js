
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();
const prisma = new PrismaClient();
const resend = new Resend(process.env.RESEND_API_KEY);

const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'https://aliciapanoramicpark.com';

const TOURS = {
  'alicia-panoramic-tour': {
    name: 'Alicia Panoramic Tour',
    pricePerGuest: 1500,
    description: 'Breathtaking views of Alicia, Bohol with a local guide.'
  },
  'night-camping-guide': {
    name: 'Night Camping + Guide',
    pricePerGuest: 2000,
    description: 'Overnight guided camping experience surrounded by nature.'
  }
};

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many booking attempts. Please try again later.' }
});

app.use(cors());
app.use('/api/paymongo/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function generateBookingNumber() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  return `APP-${dateStr}-${randomSuffix}`;
}

app.post('/api/create-checkout', checkoutLimiter, async (req, res) => {
  try {
    const { tour, date, guests, customerName, email, phone, specialRequests } = req.body;

    if (!tour || !TOURS[tour]) {
      return res.status(400).json({ error: 'Please select a valid tour offer.' });
    }
    if (!date || new Date(date) < new Date(new Date().setHours(0,0,0,0))) {
      return res.status(400).json({ error: 'Please select a valid future date.' });
    }
    const guestCount = parseInt(guests, 10);
    if (isNaN(guestCount) || guestCount < 1 || guestCount > 30) {
      return res.status(400).json({ error: 'Guest count must be between 1 and 30.' });
    }
    if (!customerName || !email || !phone) {
      return res.status(400).json({ error: 'Name, email, and phone number are required.' });
    }

    const selectedTour = TOURS[tour];
    const totalAmount = selectedTour.pricePerGuest * guestCount;
    const amountInCents = totalAmount * 100;
    const bookingNumber = generateBookingNumber();

    const booking = await prisma.booking.create({
      data: {
        bookingNumber,
        tour: selectedTour.name,
        bookingDate: date,
        guests: guestCount,
        customerName,
        customerEmail: email,
        customerPhone: phone,
        specialRequests: specialRequests || '',
        amount: totalAmount,
        currency: 'PHP',
        bookingStatus: 'PENDING_PAYMENT',
        paymentStatus: 'unpaid'
      }
    });

    const paymongoAuth = Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
    
    const paymongoPayload = {
      data: {
        attributes: {
          billing: {
            name: customerName,
            email: email,
            phone: phone
          },
          line_items: [
            {
              currency: 'PHP',
              amount: amountInCents,
              description: selectedTour.description,
              name: selectedTour.name,
              quantity: 1
            }
          ],
          payment_method_types: ['card', 'gcash', 'paymaya'],
          success_url: `${APP_URL}/booking-success?ref=${bookingNumber}`,
          cancel_url: `${APP_URL}/booking-failed?ref=${bookingNumber}`,
          description: `Alicia Park Booking #${bookingNumber}`,
          metadata: {
            booking_number: bookingNumber
          }
        }
      }
    };

    const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${paymongoAuth}`
      },
      body: JSON.stringify(paymongoPayload)
    });

    const sessionData = await response.json();

    if (!response.ok || !sessionData.data) {
      console.error('PayMongo API Error:', sessionData);
      return res.status(500).json({ error: 'Failed to initiate PayMongo payment session.' });
    }

    const checkoutUrl = sessionData.data.attributes.checkout_url;
    const checkoutSessionId = sessionData.data.id;

    await prisma.booking.update({
      where: { id: booking.id },
      data: { paymongoCheckoutId: checkoutSessionId }
    });

    return res.json({
      success: true,
      checkoutUrl,
      bookingNumber
    });

  } catch (error) {
    console.error('Checkout creation error:', error);
    return res.status(500).json({ error: 'Server error while processing booking.' });
  }
});

app.post('/api/paymongo/webhook', async (req, res) => {
  const signatureHeader = req.headers['paymongo-signature'];
  const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;

  if (!signatureHeader || !webhookSecret) {
    return res.status(400).send('Missing webhook signature or secret');
  }

  try {
    const rawBody = req.body.toString('utf8');

    const sigParts = signatureHeader.split(',').reduce((acc, part) => {
      const [key, value] = part.split('=');
      if (key && value) acc[key.trim()] = value.trim();
      return acc;
    }, {});

    const timestamp = sigParts.t;
    const liveSig = sigParts.li;
    const testSig = sigParts.te;

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    const isValidSignature = (liveSig && liveSig === expectedSignature) || (testSig && testSig === expectedSignature);

    if (!isValidSignature) {
      console.error('Invalid PayMongo Webhook Signature');
      return res.status(401).send('Unauthorized webhook signature');
    }

    const event = JSON.parse(rawBody);
    const eventType = event?.data?.attributes?.type;

    if (eventType === 'checkout_session.payment.paid' || eventType === 'payment.paid') {
      const paymentAttributes = event.data.attributes.data.attributes;
      const checkoutSessionId = paymentAttributes.checkout_session_id || event.data.attributes.data.id;
      const paymentId = event.data.attributes.data.id;
      const paidAmount = paymentAttributes.amount / 100;

      const booking = await prisma.booking.findFirst({
        where: {
          OR: [
            { paymongoCheckoutId: checkoutSessionId },
            { bookingNumber: paymentAttributes.metadata?.booking_number || '' }
          ]
        }
      });

      if (!booking) {
        return res.status(200).send('Webhook acknowledged (no matching booking)');
      }

      if (booking.bookingStatus === 'PAID') {
        return res.status(200).send('Webhook acknowledged (already processed)');
      }

      if (paidAmount < booking.amount) {
        await prisma.booking.update({
          where: { id: booking.id },
          data: { bookingStatus: 'PAYMENT_FAILED', paymentStatus: 'failed' }
        });
        return res.status(400).send('Payment amount mismatch');
      }

      const updatedBooking = await prisma.booking.update({
        where: { id: booking.id },
        data: {
          bookingStatus: 'PAID',
          paymentStatus: 'paid',
          paymongoPaymentId: paymentId,
          emailSent: true
        }
      });

      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'bookings@aliciapanoramicpark.com',
        to: [updatedBooking.customerEmail],
        subject: `Booking Confirmation – Alicia Panoramic Park – ${updatedBooking.bookingNumber}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
            <h2 style="color: #2e7d32;">Booking Confirmed!</h2>
            <p>Dear ${updatedBooking.customerName},</p>
            <p>Thank you for booking with <strong>Alicia Panoramic Park</strong>. Your payment has been received and confirmed.</p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
              <tr><td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Booking Number:</strong></td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${updatedBooking.bookingNumber}</td></tr>
              <tr><td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Tour Experience:</strong></td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${updatedBooking.tour}</td></tr>
              <tr><td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Date:</strong></td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${updatedBooking.bookingDate}</td></tr>
              <tr><td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Guests:</strong></td><td style="padding: 8px; border-bottom: 1px solid #ddd;">${updatedBooking.guests}</td></tr>
              <tr><td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Amount Paid:</strong></td><td style="padding: 8px; border-bottom: 1px solid #ddd;">₱${updatedBooking.amount.toLocaleString()} PHP</td></tr>
              <tr><td style="padding: 8px; border-bottom: 1px solid #ddd;"><strong>Payment Status:</strong></td><td style="padding: 8px; border-bottom: 1px solid #ddd; color: #2e7d32; font-weight: bold;">PAID</td></tr>
            </table>
            <p><strong>Special Requests:</strong> ${updatedBooking.specialRequests || 'None'}</p>
            <p style="margin-top: 30px;"><a href="${APP_URL}/booking-success?ref=${updatedBooking.bookingNumber}" style="background-color: #2e7d32; color: white; padding: 12px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">View Booking Online</a></p>
          </div>
        `
      });

      if (process.env.ADMIN_EMAIL) {
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL || 'bookings@aliciapanoramicpark.com',
          to: [process.env.ADMIN_EMAIL],
          subject: `New Paid Booking #${updatedBooking.bookingNumber}`,
          html: `
            <h3>New Confirmed Paid Booking</h3>
            <p><strong>Ref:</strong> ${updatedBooking.bookingNumber}</p>
            <p><strong>Customer:</strong> ${updatedBooking.customerName} (${updatedBooking.customerEmail}, ${updatedBooking.customerPhone})</p>
            <p><strong>Tour:</strong> ${updatedBooking.tour}</p>
            <p><strong>Date:</strong> ${updatedBooking.bookingDate}</p>
            <p><strong>Guests:</strong> ${updatedBooking.guests}</p>
            <p><strong>Total Paid:</strong> ₱${updatedBooking.amount.toLocaleString()} PHP</p>
            <p><strong>PayMongo Ref:</strong> ${paymentId}</p>
          `
        });
      }
    }

    return res.status(200).send('Webhook processed successfully');

  } catch (error) {
    console.error('Webhook execution error:', error);
    return res.status(500).send('Webhook server error');
  }
});

app.get('/api/booking/:bookingNumber', async (req, res) => {
  try {
    const { bookingNumber } = req.params;
    const booking = await prisma.booking.findUnique({
      where: { bookingNumber }
    });

    if (!booking) {
      return res.status(404).json({ error: 'Booking reference not found.' });
    }

    return res.json({
      bookingNumber: booking.bookingNumber,
      tour: booking.tour,
      bookingDate: booking.bookingDate,
      guests: booking.guests,
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      amount: booking.amount,
      bookingStatus: booking.bookingStatus,
      paymentStatus: booking.paymentStatus,
      message: 
        booking.bookingStatus === 'PAID' ? 'Booking Confirmed' :
        booking.bookingStatus === 'PENDING_PAYMENT' ? 'Waiting for payment confirmation.' :
        booking.bookingStatus === 'PAYMENT_FAILED' ? 'Payment unsuccessful' : 'Cancelled'
    });
  } catch (error) {
    return res.status(500).json({ error: 'Error fetching booking status.' });
  }
});

app.get('/booking-success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/booking-failed', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Alicia Park Backend Server running on port ${PORT}`);
});