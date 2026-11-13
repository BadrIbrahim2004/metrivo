function doPost(event) {
  try {
    var body = JSON.parse(event.postData.contents);
    if (!isValidRequest(body)) {
      return jsonResponse({ sent: false });
    }

    MailApp.sendEmail({
      to: body.email,
      subject: 'كود تفعيل Metrivo',
      body: 'كود تفعيل جهازك هو ' + body.code +
        '. صالح لمدة 5 دقائق فقط. إذا لم تطلبه فتجاهل هذه الرسالة.',
      htmlBody: '<p>كود تفعيل جهازك هو:</p>' +
        '<p style="font-size:28px;font-weight:bold;letter-spacing:8px">' +
        body.code + '</p>' +
        '<p>صالح لمدة 5 دقائق فقط. إذا لم تطلبه فتجاهل هذه الرسالة.</p>',
      name: 'Metrivo'
    });

    return jsonResponse({ sent: true });
  } catch (error) {
    console.error(
      'Metrivo activation email failed: ' +
      (error && error.name ? error.name : 'Unknown error')
    );
    return jsonResponse({ sent: false });
  }
}

function isValidRequest(body) {
  if (
    !body ||
    typeof body.email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ||
    typeof body.code !== 'string' ||
    !/^\d{6}$/.test(body.code) ||
    typeof body.expiresAt !== 'string' ||
    typeof body.timestamp !== 'number' ||
    !isFinite(body.timestamp) ||
    Math.floor(body.timestamp) !== body.timestamp ||
    typeof body.signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.signature)
  ) {
    return false;
  }

  var now = new Date().getTime();
  if (body.timestamp > now + 10000 || now - body.timestamp > 60000) {
    return false;
  }

  var expiresAt = Date.parse(body.expiresAt);
  if (
    !isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 5 * 60000 + 10000
  ) {
    return false;
  }

  var secret = PropertiesService.getScriptProperties()
    .getProperty('METRIVO_MAILER_SHARED_SECRET');
  if (
    !secret ||
    Utilities.newBlob(secret).getBytes().length < 32
  ) {
    return false;
  }

  var signedPayload = body.timestamp + '\n' +
    body.email + '\n' +
    body.code + '\n' +
    body.expiresAt;
  var expected = Utilities.computeHmacSha256Signature(signedPayload, secret)
    .map(function (value) {
      return (value + 256) % 256;
    })
    .map(function (value) {
      var hex = value.toString(16);
      return hex.length < 2 ? '0' + hex : hex;
    })
    .join('');

  return constantTimeEqual(body.signature, expected);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  var difference = 0;
  for (var index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
