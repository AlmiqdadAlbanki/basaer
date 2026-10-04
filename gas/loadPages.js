function loadPages_(page) {
  return HtmlService.createTemplateFromFile(page).evaluate().getContent();
}

function loadPageRegistration(){
  return loadPages_('registration');
}

function loadPageLogin(){
  return loadPages_('login');
}

function loadPageStudent(){
  return loadPages_('student');
}

function loadPageEmp(){
  return loadPages_('emp');
}

function loadPageAttending(){
  return loadPages_('attend');
}

function loadPageNewStuReg(){
  return loadPages_('newStuReg');
}

function loadPageCurrentStus(){
  return loadPages_('currentStus');
}

function loadPageSendMsg(){
  return loadPages_('sendMsg');
}

function loadPageStuManag(){
  return loadPages_('stuManag');
}

function loadPageEmpManag(){
  return loadPages_('empManag');
}

function loadPagellAttend(){
  return loadPages_('allAttend');
}

function loadPageIqrar(){
  return loadPages_('Iqrar');
}

function loadPageQuestions(){
  return loadPages_('questions');
}

function loadPageProfile(){
  return loadPages_('profile');
}


// أضف هذه الدالة في loadPages_.gs لفتح الصفحة
function loadHomePage(){
  return loadPages_('homePage');
}


function loadPageAdminDashboard(){
  return loadPages_('adminDashboard');
}
