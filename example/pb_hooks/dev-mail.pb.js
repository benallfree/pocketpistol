// Example host only: catch outgoing mail instead of sending it, so development
// and tests never reach a real inbox. Each message is logged as one
// "DEVMAIL {json}" line. Set EXAMPLE_SEND_REAL_MAIL=1 to send for real through
// the SMTP settings.
onMailerSend((e) => {
  if ($os.getenv('EXAMPLE_SEND_REAL_MAIL') === '1') return e.next()
  const m = e.message
  console.log(
    'DEVMAIL ' +
      JSON.stringify({
        from: m.from.address,
        to: m.to.map((a) => a.address),
        subject: m.subject,
        headers: m.headers,
        html: m.html,
      })
  )
  // not calling e.next(): the message is not sent
})
