const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Create Checkout Session Endpoint with QRPh enabled
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, guests } = req.body;
        
        // Amount calculation in centavos (e.g., ₱750.00 = 75000)
        // Adjust this dynamically if you add more tours with different pricing
        const amountInCentavos = 75000; 

        const options = {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: 'Basic ' + Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64')
            },
            body: JSON.stringify({
                data: {
                    attributes: {
                        amount: amountInCentavos,
                        currency: 'PHP',
                        description: `${tour} - ${guests} Guest(s) on ${bookingDate}`,
                        // 👇 Including 'qrph' here ensures Scan to Pay shows up on your checkout page
                        payment_method_allowed: ['card', 'gcash', 'qrph'],
                        success_url: 'https://' + req.get('host') + '/success.html',
                        cancel_url: 'https://' + req.get('host') + '/index.html'
                    }
                }
            })
        };

        const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', options);
        const data = await response.json();

        if (response.ok && data.data) {
            res.json({ checkoutUrl: data.data.attributes.checkout_url });
        } else {
            const errorMsg = data.errors ? data.errors[0].detail : 'Checkout creation failed';
            res.status(400).json({ error: errorMsg });
        }
    } catch (err) {
        console.error('PayMongo Checkout Error:', err);
        res.status(500).json({ error: 'Server error connecting to payment gateway.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});