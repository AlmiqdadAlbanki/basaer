function sendImageToWhatsApp_(blobImage, phoneNumber, fileName) {
  // 1. رفع الصورة على Google Drive
  const file = DriveApp.createFile(blobImage.setName(fileName));
  shareFileAnyoneWithLink_(file.getId());

  // 2. الحصول على رابط مباشر لعرض الصورة
  const fileId = file.getId();
  const directImageUrl = "https://drive.google.com/uc?export=view&id=" + fileId;

  // 3. تجهيز بيانات الطلب إلى Fonnte API
  const payload = {
    target: phoneNumber,       // بصيغة دولية: مثلاً "201234567890"
    url: directImageUrl,       // رابط الصورة
    filename: fileName,        // اسم الملف (مثلاً: "converted.png")
    countryCode: '0'           // إلزامي — بدونه Fonnte تفترض إندونيسيا (62) وتُفسد أي رقم دولي آخر، راجع sendWPRaw_ بـdataPost.js
  };

  // 4. إرسال الطلب
  const options = {
    method: "post",
    payload: payload,
    headers: headersForWatsapp,
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch("https://api.fonnte.com/send", options);
  Logger.log("Fonnte response: " + response.getContentText());
}


////////////////////////////////////////////////////////////////////////////////////////////

function testSendImage() {
  const phone = "201234567890"; // رقم المستلم
  const fileName = "converted.png";

  // مثال على Blob (افترض إن عندك blob جاهز)
  const blob = UrlFetchApp.fetch("https://via.placeholder.com/600x800.png").getBlob();

  sendImageToWhatsApp_(blob, phone, fileName);
}
