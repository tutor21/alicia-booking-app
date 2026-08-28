let selectedPrice = 1500;
let currentTourKey = 'alicia-panoramic-tour';

function showSection(sectionId) {
  document.querySelectorAll('.page-section').forEach(sec => sec.classList.add('hidden'));
  const target = document.getElementById(sectionId);
  if (target) target.classList.remove('hidden');
}

function selectTour(tourKey, price) {
  currentTourKey = tourKey;
  selectedPrice = price;
  const tourInput = document.getElementById('tour-name');
  if (tourInput) {
    tourInput.value = tourKey === 'alicia-panoramic-tour' ? 'Alicia Panoramic Tour' : 'Night Camping + Guide';
  }
  updateTotal();
  showSection('booking');
}

function updateTotal() {
  const countInput = document.getElementById('guest-count');
  const count = parseInt(countInput ? countInput.value : 1, 10) || 1;
  const totalElem = document.getElementById('total-price');
  if (totalElem) {
    totalElem.innerText = (count * selectedPrice).toLocaleString();
  }
}

async function handleBooking(event) {
  event.preventDefault();

  const date = document.getElementById('tour-date').value;
  const guests = parseInt(document.getElementById('guest-count').value, 10) || 1;
  const customerName = document.getElementById('customer-name').value;
  const email = document.getElementById('customer-email').value;
  const phone = document.getElementById('customer-phone').value;
  const specialRequests = document.getElementById('special-requests')?.value || '';

  const submitBtn = event.target.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Connecting to PayMongo...';
  }

  try {
    const response = await fetch('/api/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tour: currentTourKey,
        date,
        guests,
        customerName,
        email,
        phone,
        specialRequests
      })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      alert(data.error || 'Failed to initiate booking. Please try again.');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = 'Pay via PayMongo';
      }
      return;
    }

    window.location.href = data.checkoutUrl;

  } catch (error) {
    console.error('Booking error:', error);
    alert('Server connection error. Please try again.');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = 'Pay via PayMongo';
    }
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const bookingRef = urlParams.get('ref');

  if (window.location.pathname === '/booking-success' && bookingRef) {
    showSection('booking');
    const receiptBox = document.getElementById('booking-receipt');
    if (receiptBox) {
      receiptBox.classList.remove('hidden');
      receiptBox.innerHTML = '<p>Verifying payment status with server...</p>';

      try {
        const response = await fetch(`/api/booking/${bookingRef}`);
        const data = await response.json();

        if (data.bookingStatus === 'PAID') {
          receiptBox.className = 'receipt status-paid';
          receiptBox.innerHTML = `
            <h3>Booking Confirmed!</h3>
            <p><strong>Booking Number:</strong> ${data.bookingNumber}</p>
            <p><strong>Status:</strong> <span style="color:#2e7d32; font-weight:bold;">${data.message}</span></p>
            <p><strong>Tour:</strong> ${data.tour}</p>
            <p><strong>Date:</strong> ${data.bookingDate}</p>
            <p><strong>Guests:</strong> ${data.guests}</p>
            <p><strong>Total Paid:</strong> ₱${data.amount.toLocaleString()} PHP</p>
            <p style="font-size:0.9em; color:#666;">A confirmation receipt has been sent to ${data.customerEmail}.</p>
          `;
        } else {
          receiptBox.className = 'receipt status-pending';
          receiptBox.innerHTML = `
            <h3>${data.message}</h3>
            <p>Ref ID: ${data.bookingNumber}</p>
            <p>Your payment is currently being processed by PayMongo. Please check your email shortly.</p>
          `;
        }
      } catch (err) {
        receiptBox.innerHTML = '<p>Unable to retrieve booking status. Please check your email.</p>';
      }
    }
  } else if (window.location.pathname === '/booking-failed' && bookingRef) {
    showSection('booking');
    const receiptBox = document.getElementById('booking-receipt');
    if (receiptBox) {
      receiptBox.classList.remove('hidden');
      receiptBox.className = 'receipt status-failed';
      receiptBox.innerHTML = `
        <h3 style="color:#d32f2f;">Payment Unsuccessful</h3>
        <p>Ref ID: ${bookingRef}</p>
        <p>Your payment could not be completed. Your booking has not been confirmed.</p>
        <button onclick="showSection('tours')">Try Again</button>
      `;
    }
  }
});
