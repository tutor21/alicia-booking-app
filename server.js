require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;

const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, guests, amount, secretKey } = req.body;

        if (!tour || !customerName || !customerEmail || !bookingDate || !guests) {
            return res.status(400).json({ error: 'Missing required booking details.' });
        }

        let amountInCents = 75000;
        if (amount !== undefined && !isNaN(amount)) {
            amountInCents = Math.round(parseFloat(amount) * 100);
        } else if (tour === "Alicia Panoramic Park Tour") {
            amountInCents = 75000; 
        }

        // Use custom secret key from diagnostic console if provided, otherwise fallback to server .env
        const paymongoSecretKey = secretKey && secretKey.startsWith('sk_') ? secretKey : process.env.PAYMONGO_SECRET_KEY;
        if (!paymongoSecretKey) {
            return res.status(500).json({ error: 'PayMongo secret key is not configured on the server or provided in test console.' });
        }

        const host = req.get('host');
        const protocol = req.protocol;

        const paymongoPayload = {
            data: {
                attributes: {
                    billing: {
                        name: customerName,
                        email: customerEmail,
                        phone: customerPhone || 'N/A'
                    },
                    send_email_receipt: true,
                    show_description: true,
                    show_line_items: true,
                    cancel_url: `${protocol}://${host}/index.html`,
                    success_url: `${protocol}://${host}/success.html?session_id={CHECKOUT_SESSION_ID}`,
                    description: `TAPP Tours - ${tour}`,
                    line_items: [
                        {
                            currency: 'PHP',
                            amount: amountInCents,
                            description: `Booking Date: ${bookingDate} | Group Size: ${guests} Guest(s)`,
                            name: tour,
                            quantity: 1
                        }
                    ],
                    payment_method_types: ['card', 'gcash', 'paymaya', 'qrph'],
                    metadata: {
                        customerName,
                        customerPhone: customerPhone || 'N/A',
                        bookingDate,
                        guests: guests.toString(),
                        tourName: tour
                    }
                }
            }
        };

        const encodedKey = Buffer.from(`${paymongoSecretKey}:`).toString('base64');

        const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${encodedKey}`
            },
            body: JSON.stringify(paymongoPayload)
        });

        const data = await response.json();

        if (!response.ok || !data.data) {
            console.error("PayMongo Error:", data);
            const errorMessage = data.errors && data.errors[0] ? data.errors[0].detail : 'Failed to initiate PayMongo checkout session.';
            return res.status(500).json({ error: errorMessage, details: data });
        }

        const checkoutUrl = data.data.attributes.checkout_url;
        res.json({ checkoutUrl, keyUsed: paymongoSecretKey.substring(0, 10) + '...' });

    } catch (error) {
        console.error("Checkout Error:", error);
        res.status(500).json({ error: error.message || 'Internal server error while setting up payment.' });
    }
});

app.post('/api/paymongo/webhook', async (req, res) => {
    try {
        const event = req.body.data;
        const eventType = event?.attributes?.type;

        if (eventType === 'checkout_session.payment.paid') {
            const checkoutData = event.attributes.data;
            const metadata = checkoutData.attributes.metadata || {};
            const billing = checkoutData.attributes.billing || {};
            
            const customerEmail = billing.email || metadata.customerEmail;
            const customerName = billing.name || metadata.customerName || 'Valued Guest';
            const tourName = metadata.tourName || metadata.tour || 'Alicia Panoramic Park Tour';
            const bookingDate = metadata.bookingDate || 'N/A';
            const guests = metadata.guests || '1';
            const amountPaid = checkoutData.attributes.line_items[0].amount / 100;
            const sessionId = checkoutData.id;

            console.log(`✅ Payment successful for ${customerName} (${customerEmail}). Triggering Resend emails...`);

            if (customerEmail && process.env.RESEND_API_KEY) {
                await resend.emails.send({
                    from: process.env.RESEND_FROM_EMAIL || 'bookings@aliciapanoramicpark.com',
                    to: [customerEmail],
                    subject: `Booking Confirmed! – Alicia Panoramic Park (${tourName})`,
                    html: `
                      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
                        <h2 style="color: #2e7d32; margin-top: 0;">Booking Confirmed!</h2>
                        <p>Dear ${customerName},</p>
                        <p>Thank you for booking with <strong>TAPP Tours / Alicia Panoramic Park</strong>. Your payment has been successfully verified and confirmed.</p>
                        
                        <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
                          <tr><td style="padding: 10px; border-bottom: 1px solid #ddd;"><strong>Tour Experience:</strong></td><td style="padding: 10px; border-bottom: 1px solid #ddd;">${tourName}</td></tr>
                          <tr><td style="padding: 10px; border-bottom: 1px solid #ddd;"><strong>Visit Date:</strong></td><td style="padding: 10px; border-bottom: 1px solid #ddd;">${bookingDate}</td></tr>
                          <tr><td style="padding: 10px; border-bottom: 1px solid #ddd;"><strong>Group Size:</strong></td><td style="padding: 10px; border-bottom: 1px solid #ddd;">${guests} Guest(s)</td></tr>
                          <tr><td style="padding: 10px; border-bottom: 1px solid #ddd;"><strong>Amount Paid:</strong></td><td style="padding: 10px; border-bottom: 1px solid #ddd; color: #2e7d32; font-weight: bold;">₱${amountPaid.toLocaleString()} PHP</td></tr>
                          <tr><td style="padding: 10px; border-bottom: 1px solid #ddd;"><strong>Status:</strong></td><td style="padding: 10px; border-bottom: 1px solid #ddd; color: #2e7d32; font-weight: bold;">PAID & CONFIRMED</td></tr>
                        </table>

                        <p>We look forward to hosting your adventure in Bohol! If you have any questions, feel free to reply to this email.</p>
                        <p style="font-size: 12px; color: #777; margin-top: 30px; border-top: 1px solid #eee; pt: 15px;">PayMongo Reference ID: ${sessionId}</p>
                      </div>
                    `
                });
            }

            if (process.env.ADMIN_EMAIL && process.env.RESEND_API_KEY) {
                await resend.emails.send({
                    from: process.env.RESEND_FROM_EMAIL || 'bookings@aliciapanoramicpark.com',
                    to: [process.env.ADMIN_EMAIL],
                    subject: `🚨 New Paid Booking: ${tourName} (${customerName})`,
                    html: `
                      <h3>New Confirmed Paid Booking</h3>
                      <p><strong>Customer Name:</strong> ${customerName}</p>
                      <p><strong>Email:</strong> ${customerEmail}</p>
                      <p><strong>Phone:</strong> ${billing.phone || metadata.customerPhone || 'N/A'}</p>
                      <p><strong>Tour:</strong> ${tourName}</p>
                      <p><strong>Date:</strong> ${bookingDate}</p>
                      <p><strong>Guests:</strong> ${guests}</p>
                      <p><strong>Total Paid:</strong> ₱${amountPaid.toLocaleString()} PHP</p>
                      <p><strong>PayMongo Session ID:</strong> ${sessionId}</p>
                    `
                });
            }
        }

        res.status(200).json({ received: true });
    } catch (err) {
        console.error('Webhook Resend error:', err);
        res.status(400).send(`Webhook Handler Error: ${err.message}`);
    }
});

app.listen(PORT, () => {
    console.log(`✅ TAPP Tours server with Resend & Key Override running on port ${PORT}`);
});