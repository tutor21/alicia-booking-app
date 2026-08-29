const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Explicit Blog Routes
app.get('/blog-1', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog-1.html'));
});

app.get('/blog-2', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog-2.html'));
});

app.get('/blog-3', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog-3.html'));
});

async function createParkBookingSession(bookingDetails, host) {
  const paymongoSecretKey = process.env.PAYMONGO_SECRET_KEY;
  // Updated to use the V2 Checkout Sessions endpoint required for pass_on_fees
  const url = 'https://api.paymongo.com/v2/checkout_sessions';
  
  const options = {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(paymongoSecretKey + ':').toString('base64')}`
    },
    body: JSON.stringify({
      data: {
        attributes: {
          show_description: true,
          show_line_items: true,
          pass_on_fees: true, 
          payment_method_types: ['card', 'gcash', 'maya', 'qrph'],
          line_items: [
            {
              amount: bookingDetails.totalPriceInCents, 
              currency: 'PHP',
              name: `Alicia Panoramic Park - ${bookingDetails.tourType}`, 
              quantity: bookingDetails.guestCount
            }
          ],
          description: `Booking date: ${bookingDetails.bookingDate} | Customer: ${bookingDetails.customerName} (${bookingDetails.customerEmail})`,
          success_url: `https://${host}/index.html?success=true`,
          cancel_url: `https://${host}/index.html`
        }
      }
    })
  };

  const response = await fetch(url, options);
  const result = await response.json();
  
  if (!response.ok) {
    throw new Error(result.errors?.[0]?.detail || 'Session creation failed');
  }
  
  return result.data.attributes.checkout_url;
}

// Create Checkout Session Endpoint
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, guests } = req.body;
        
        // Base amount in cents (₱750.00 base per booking unit)
        const baseAmount = 75000; 
        const guestCount = parseInt(guests) || 1;

        const bookingDetails = {
            tourType: tour || 'Alicia Panoramic Park Tour',
            guestCount: guestCount,
            totalPriceInCents: baseAmount,
            bookingDate: bookingDate,
            customerName: customerName,
            customerEmail: customerEmail
        };

        const checkoutUrl = await createParkBookingSession(bookingDetails, req.get('host'));
        res.json({ checkoutUrl });
    } catch (err) {
        console.error('Booking Payment Error:', err.message);
        res.status(400).json({ error: err.message || 'Server error connecting to payment gateway.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});