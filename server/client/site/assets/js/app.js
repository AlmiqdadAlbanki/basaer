(() => {
  const menuButton = document.querySelector('.menu-button');
  const nav = document.querySelector('.main-nav');
  const closeMenu = () => { nav?.classList.remove('open'); menuButton?.setAttribute('aria-expanded','false'); };
  menuButton?.addEventListener('click', event => { event.stopPropagation(); const isOpen=nav.classList.toggle('open'); menuButton.setAttribute('aria-expanded',String(isOpen)); });
  nav?.addEventListener('click', event => { if(event.target.closest('a')) closeMenu(); });
  document.addEventListener('click', event => { if(nav?.classList.contains('open') && !nav.contains(event.target) && !menuButton.contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', event => { if(event.key==='Escape') closeMenu(); });

  const goals={foundation:{text:'اعرض المراحل المناسبة لي',href:'#stages'},review:{text:'ابدأ اختبار تحديد المستوى',href:'#'},certificate:{text:'اعرض البرامج المؤهلة للشهادة',href:'#courses'}};
  const goalCards=document.querySelectorAll('.goal-card'); const cta=document.querySelector('#goal-cta');
  goalCards.forEach(card=>card.addEventListener('click',()=>{goalCards.forEach(i=>i.classList.remove('selected'));card.classList.add('selected');const goal=goals[card.dataset.goal];cta.innerHTML=`${goal.text} <span>←</span>`;cta.href=goal.href;}));

  document.querySelector('.newsletter')?.addEventListener('submit',event=>{event.preventDefault();const b=event.currentTarget.querySelector('button');b.textContent='✓';setTimeout(()=>b.textContent='←',1800)});

  const stageData={
    1:{kicker:'المرحلة الأولى',title:'المرحلة التأهيلية',text:'تهيئة الطالب لبدء رحلته العلمية وبناء الدافعية وأدوات التعلّم.',image:'stage-qualifying-correct.png'},
    2:{kicker:'المرحلة الثانية',title:'المرحلة التأسيسية',text:'بناء الأساس العلمي الذي يحتاجه الطالب قبل الانتقال إلى الدراسة المتعمقة.',image:'stage-foundation-correct.png'},
    3:{kicker:'المرحلة الثالثة',title:'المرحلة التأصيلية',text:'تأصيل العلوم الشرعية ومفاتيحها وفق منهجية متدرجة ومنظمة.',image:'stage-rooting-correct.png'},
    4:{kicker:'المرحلة الرابعة',title:'المرحلة التحصيلية',text:'توسيع التحصيل وربط المعارف وتنمية القدرة على الفهم والتحليل.',image:'stage-achievement-correct.png'}
  };
  const modal=document.querySelector('#stage-modal');
  const closeModal=()=>{modal?.classList.remove('open');modal?.setAttribute('aria-hidden','true');document.body.style.overflow=''};
  document.querySelectorAll('.stage-card').forEach(card=>card.addEventListener('click',()=>{const d=stageData[card.dataset.stage];modal.querySelector('#stage-modal-kicker').textContent=d.kicker;modal.querySelector('#stage-modal-title').textContent=d.title;modal.querySelector('#stage-modal-text').textContent=d.text;const logo=modal.querySelector('.modal-stage-logo-image');logo.src=`assets/images/${d.image}`;logo.alt=`شعار ${d.title}`;modal.classList.add('open');modal.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';}));
  modal?.querySelector('.modal-close')?.addEventListener('click',closeModal); modal?.querySelector('.modal-backdrop')?.addEventListener('click',closeModal);

  const track=document.querySelector('.lecturers-track'); let slideIndex=0; let autoTimer;
  const cards=()=>document.querySelectorAll('.lecturer-card');
  const visibleCount=()=>innerWidth<=700?1:innerWidth<=1100?2:3;
  const updateSlider=()=>{if(!track)return;const card=cards()[0];if(!card)return;const gap=18;const max=Math.max(0,cards().length-visibleCount());slideIndex=Math.min(slideIndex,max);track.style.transform=`translateX(${slideIndex*(card.getBoundingClientRect().width+gap)}px)`;};
  const move=dir=>{const max=Math.max(0,cards().length-visibleCount());slideIndex=dir>0?(slideIndex>=max?0:slideIndex+1):(slideIndex<=0?max:slideIndex-1);updateSlider();};
  document.querySelector('.lecturer-next')?.addEventListener('click',()=>move(1));document.querySelector('.lecturer-prev')?.addEventListener('click',()=>move(-1));
  const startAuto=()=>{clearInterval(autoTimer);autoTimer=setInterval(()=>move(1),4200)};startAuto();track?.addEventListener('mouseenter',()=>clearInterval(autoTimer));track?.addEventListener('mouseleave',startAuto);addEventListener('resize',updateSlider);

  const backTop=document.querySelector('.back-to-top'); addEventListener('scroll',()=>backTop?.classList.toggle('show',scrollY>500),{passive:true});backTop?.addEventListener('click',()=>scrollTo({top:0,behavior:'smooth'}));

  const body=document.body,studio=document.querySelector('#theme-studio'),fontSelect=document.querySelector('#font-select'),radiusSelect=document.querySelector('#radius-select'),cardSelect=document.querySelector('#card-select');
  const fontMap={ibm:"'IBM Plex Sans Arabic', sans-serif",readex:"'Readex Pro', sans-serif",alexandria:"'Alexandria', sans-serif",tajawal:"'Tajawal', sans-serif"};
  const defaults={font:'ibm',color:'basair',radius:'soft',cards:'bordered'};let saved={};try{saved=JSON.parse(localStorage.getItem('basair-studio-preferences')||'{}')}catch(e){}const state={...defaults,...saved};
  function applyTheme(){document.documentElement.style.setProperty('--font-ui',fontMap[state.font]);body.dataset.colorTheme=state.color;body.dataset.radius=state.radius;body.dataset.cards=state.cards;if(fontSelect)fontSelect.value=state.font;if(radiusSelect)radiusSelect.value=state.radius;if(cardSelect)cardSelect.value=state.cards;document.querySelectorAll('.swatch').forEach(btn=>btn.classList.toggle('is-active',btn.dataset.theme===state.color));localStorage.setItem('basair-studio-preferences',JSON.stringify(state));}
  applyTheme();fontSelect?.addEventListener('change',e=>{state.font=e.target.value;applyTheme()});radiusSelect?.addEventListener('change',e=>{state.radius=e.target.value;applyTheme()});cardSelect?.addEventListener('change',e=>{state.cards=e.target.value;applyTheme()});document.querySelectorAll('.swatch').forEach(btn=>btn.addEventListener('click',()=>{state.color=btn.dataset.theme;applyTheme()}));document.querySelector('#reset-theme')?.addEventListener('click',()=>{Object.assign(state,defaults);applyTheme()});document.querySelector('#studio-close')?.addEventListener('click',()=>studio.classList.add('is-collapsed'));document.querySelector('#studio-toggle')?.addEventListener('click',()=>studio.classList.remove('is-collapsed'));document.querySelector('#focus-mode')?.addEventListener('click',()=>body.classList.add('focus-preview'));document.addEventListener('keydown',e=>{if(e.key==='Escape'){body.classList.remove('focus-preview');closeModal();}});
})();

// Detailed complementary-program data transcribed from the approved profile PDF.
document.addEventListener('DOMContentLoaded', () => {
  const data = {
    skills: {
      logo: 'م',
      image: 'program-art-skills.png',
      title: 'الدورات المهارية',
      intro: 'تُعد هذه الدورات بمثابة المفاتيح والأساليب والاستراتيجيات التي يحتاجها الطالب لتعينه في مختلف المجالات العلمية والتقنية والواقعية، بما يسهم في مواكبة الواقع وتقصير طريق التعلم من خلال الخبرات، مع متابعة تطبيق ما تم أخذه فيها.',
      heading: 'مهارات الدراسة',
      items: ['مهارة الحفظ','مهارة القراءة','مهارة التخطيط في حياة طالب العلم','مهارة البحث العلمي وبناء المكتبة','مهارة الفهم والتحليل','مهارة الكتابة والتلخيص','مهارة التعليم','مهارة التعامل مع المخالف','مهارة التعامل مع البيئة','مهارة السؤال والحوار والمناظرة'],
      note: 'تعتمد مواد الدراسة على مقررات «غراس العلم».'
    },
    hearing: {
      logo: 'س',
      image: 'program-art-hearing.png',
      title: 'مجالس السماع',
      intro: 'هي مجالس للحديث النبوي الشريف؛ يمرّ الطالب فيها على قدر من الأحاديث بأسانيدها إلى مصنفيها وإلى النبي ﷺ، مما يتعلق بموضوع معين أو موسم خاص، أو جزء منتخب من مصدر أساسي، تُقرأ على المشايخ المسندين، ويحصل الطالب فيها على إجازة بالسند المتصل.',
      heading: 'مواد الدراسة',
      items: ['الأوائل والأربعينيات','الأجزاء المتعلقة بالمواسم','أطراف الكتب التسعة','المنتخبات والمتون المدروسة'],
      note: 'تجمع المجالس بين القراءة على أهل العلم والعناية بالإجازة والإسناد.'
    },
    protection: {
      logo: 'ح',
      image: 'program-art-protection.png',
      title: 'التحصين الفكري',
      intro: 'يولي البرنامج أولوية قصوى للتحصين الفكري عبر تكامل منهجي بين تعزيز اليقين والأمن الفكري؛ لبناء حصانة تحمي العقل والمجتمع من مخاطر الأفكار المتطرفة، سعيًا إلى تحصين المجتمع من الشبهات المضللة والتيارات المنحرفة التي تستهدف النسيج الوطني والديني.',
      heading: 'المستويات والموضوعات',
      groups: [
        ['المستوى الأول: تعزيز اليقين','محاسن الإسلام وجماليات الدين','دلائل النبوة والمعجزات','وجود الخالق سبحانه وكمال صفاته'],
        ['المستوى الثاني: الأمن الفكري','طاعة ولاة الأمر','اجتماع الكلمة ونبذ الفرقة','ضوابط الأحكام والأسماء'],
        ['المستوى الثالث: الحوار والمناظرة','مصادر المعرفة','المغالطات المنطقية','مناقشة الشبهات']
      ],
      note: 'ثلاثة مستويات متكاملة تجمع بناء اليقين، والأمن الفكري، ومهارات الحوار والمناظرة.'
    }
  };
  const modal = document.querySelector('#program-modal');
  if (!modal) return;
  const close = () => { modal.classList.remove('open'); modal.setAttribute('aria-hidden','true'); document.body.style.overflow=''; };
  document.querySelectorAll('[data-program]').forEach(button => button.addEventListener('click', () => {
    const item = data[button.dataset.program];
    modal.querySelector('#program-modal-logo').innerHTML = `<img src="assets/images/${item.image}" alt="هوية ${item.title}">`;
    modal.querySelector('#program-modal-title').textContent = item.title;
    modal.querySelector('#program-modal-intro').textContent = item.intro;
    const content = modal.querySelector('#program-modal-content');
    if (item.groups) {
      content.innerHTML = `<h3>${item.heading}</h3><div class="program-levels">${item.groups.map(group => `<section><h4>${group[0]}</h4><ul>${group.slice(1).map(x => `<li>${x}</li>`).join('')}</ul></section>`).join('')}</div><p class="program-source-note">${item.note}</p>`;
    } else {
      content.innerHTML = `<h3>${item.heading}</h3><ul class="program-items">${item.items.map(x => `<li>${x}</li>`).join('')}</ul><p class="program-source-note">${item.note}</p>`;
    }
    modal.classList.add('open'); modal.setAttribute('aria-hidden','false'); document.body.style.overflow='hidden';
  }));
  modal.querySelector('.program-modal-close')?.addEventListener('click', close);
  modal.querySelector('.program-modal-backdrop')?.addEventListener('click', close);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
});

// Live clock and real Bahrain prayer times (توقيت مملكة البحرين والزبارة).
document.addEventListener('DOMContentLoaded', () => {
  const clock = document.querySelector('#prayer-clock');
  const nameEl = document.querySelector('#next-prayer-name');
  const remainingEl = document.querySelector('#next-prayer-remaining');
  const tiles = [...document.querySelectorAll('.prayer-times [data-prayer]')];
  if (!clock) return;

  const TZ = 'Asia/Bahrain';
  // Manama coordinates + the Kuwait method (Aladhan method 9), the closest public
  // match found to the official Bahraini calendar published on almajles.gov.bh
  // (within one minute across all six times) pending a direct official feed.
  const COORDS = { lat: 26.2285, lng: 50.5860 };
  const METHOD = 9;
  const LABELS = { fajr: 'الفجر', sunrise: 'الشروق', dhuhr: 'الظهر', asr: 'العصر', maghrib: 'المغرب', isha: 'العشاء' };
  const NAMED_PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const ALL_KEYS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

  const dayKey = d => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
    const get = t => parts.find(p => p.type === t).value;
    return `${get('day')}-${get('month')}-${get('year')}`;
  };

  const cache = new Map();
  async function fetchDay(d) {
    const key = dayKey(d);
    if (cache.has(key)) return cache.get(key);
    const url = `https://api.aladhan.com/v1/timings/${key}?latitude=${COORDS.lat}&longitude=${COORDS.lng}&method=${METHOD}&timezonestring=${TZ}`;
    const json = await fetch(url).then(r => r.json());
    const t = json.data.timings;
    const [dd, mm, yyyy] = key.split('-');
    const times = {};
    ALL_KEYS.forEach(k => {
      const label = k.charAt(0).toUpperCase() + k.slice(1);
      const [h, m] = t[label].split(' ')[0].split(':').map(Number);
      times[k] = new Date(`${yyyy}-${mm}-${dd}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`);
    });
    cache.set(key, times);
    return times;
  }

  function paint(times) {
    tiles.forEach(tile => {
      const strong = tile.querySelector('strong');
      const time = times[tile.dataset.prayer];
      if (strong && time) {
        strong.textContent = new Intl.DateTimeFormat('ar-BH', {
          hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TZ, numberingSystem: 'latn'
        }).format(time);
      }
    });
  }

  const pad = n => String(n).padStart(2, '0');
  let today = null;
  let loadedKey = null;

  async function loadToday() {
    const now = new Date();
    const key = dayKey(now);
    if (key === loadedKey) return;
    today = await fetchDay(now);
    loadedKey = key;
    paint(today);
  }

  async function tick() {
    const now = new Date();
    clock.textContent = new Intl.DateTimeFormat('ar-BH', {
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TZ, numberingSystem: 'latn'
    }).format(now);

    await loadToday();
    if (!today) return;

    let nextKey = NAMED_PRAYERS.find(k => today[k] > now);
    let nextTime = nextKey ? today[nextKey] : null;
    if (!nextTime) {
      const tomorrow = await fetchDay(new Date(now.getTime() + 86400000));
      nextKey = 'fajr';
      nextTime = tomorrow.fajr;
    }

    tiles.forEach(tile => tile.classList.toggle('is-next', tile.dataset.prayer === nextKey));

    const diff = Math.max(0, nextTime - now);
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    if (nameEl) nameEl.textContent = LABELS[nextKey];
    if (remainingEl) remainingEl.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  tick();
  setInterval(tick, 1000);
});

// Count homepage statistics from zero when they enter the viewport.
document.addEventListener('DOMContentLoaded', () => {
  const counters = [...document.querySelectorAll('.counter[data-target]')];
  if (!counters.length) return;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = element => {
    if (element.dataset.counted) return;
    element.dataset.counted = 'true';
    const target = Number(element.dataset.target || 0);
    const prefix = element.dataset.prefix || '';
    if (reduceMotion) {
      element.textContent = `${prefix}${target.toLocaleString('ar-BH')}`;
      return;
    }
    const duration = 1600;
    const start = performance.now();
    const tick = now => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = `${prefix}${Math.floor(target * eased).toLocaleString('ar-BH')}`;
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  if (!('IntersectionObserver' in window)) {
    counters.forEach(animate);
    return;
  }
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      animate(entry.target);
      observer.unobserve(entry.target);
    });
  }, { threshold: .45 });
  counters.forEach(counter => observer.observe(counter));
});

// Official stage definitions and requirements transcribed from the profile PDF.
document.addEventListener('DOMContentLoaded', () => {
  const stages = {
    1: {
      image: 'brand-stage-qualifying.png',
      planImage: 'stage-plan-1.png',
      books: [],
      intro: 'تُعد هذه المرحلة بمثابة التمهيد وبناء الجاهزية العلمية؛ حيث تركز على نشر مفاهيم عامة من خلال مداخل العلوم والمقدمات الضرورية، لتمكين الطالب من فهم الأدوات الأساسية والمصطلحات الأولية قبل الخوض في المتون العلمية.',
      duration: 'يوم مكثف في الشهر من بعد صلاة العصر إلى بعد صلاة العشاء، بمعدل أربع ساعات، لمدة 10 أشهر.',
      plan: 'خطة دراسية بمعدل 40 ساعة.',
      curriculum: ['السلوك والتزكية: الرسائل المفيدة للحياة السعيدة','العقيدة: القول السديد فيما لله على العبيد','التفسير: تفسير الفاتحة وقصار المفصل','الفقه: حقيبة التأهيل الفقهي','السيرة النبوية: أوجز السير','الحديث: الأربعون الولدانية','الشمائل: القول الثمين في الشمائل','الأخلاق والآداب: حلية طالب العلم','الدعوة والأذكار: الأذكار والآداب'],
      admission: ['معرفة مبادئ اللغة العربية قراءة وكتابة','ألا يقل عمر الطالب عن أربعة عشر عامًا'],
      completion: ['حضور الدورات العلمية بمجموع لا يقل عن 50%','اجتياز الاختبارات لكل كتاب بمعدل لا يقل عن 50%','المشاركة في المسابقات العلمية والثقافية والمعرفية'],
      mandatory: ['الأذكار والآداب: مختصر الأذكار للقاسم'],
      complementary: ['التزكية: منظومة في السير (18 بيتًا)']
    },
    2: {
      image: 'brand-stage-foundation.png',
      planImage: 'stage-plan-2.png',
      books: [
        ['متن العشماوية','الفقه المالكي','book-f01.png'],
        ['منظومة البيقونية','مصطلح الحديث','book-f02.png'],
        ['بداية العابد وكفاية الزاهد','الفقه الحنبلي','book-f03.png'],
        ['خلاصة تعظيم العلم','آداب طالب العلم','book-f04.png'],
        ['الوجيز في التفسير','التفسير','book-f05.png'],
        ['المختصر اللطيف','الفقه الشافعي','book-f06.png'],
        ['البيضاء في عقيدة السلف','العقيدة','book-f07.png'],
        ['القول المنير','علوم القرآن','book-f08.png'],
        ['لامية ابن الوردي','الأخلاق والآداب','book-f09.png'],
        ['الأربعون النووية','الحديث','book-f10.png'],
        ['الأرجوزة المئية','السيرة النبوية','book-f11.png'],
        ['المقدمة الآجرومية','النحو','book-f12.png']
      ],
      intro: 'تمثل مرحلة البناء الكلي للتصورات العلمية؛ حيث تُدرّس فيها أصول المسائل والقواعد الكبرى في كل فن بصورة شاملة، لضمان تكوين هيكل معرفي متماسك لدى المتعلم يربط الفروع بأصولها عبر المتون الأساسية في كل علم.',
      duration: 'يوم واحد في الأسبوع من بعد صلاة العصر إلى بعد صلاة العشاء، بمعدل ثلاث ساعات، لمدة سنة دراسية من 10 أشهر.',
      plan: 'خطة دراسية بمعدل 90 ساعة.',
      curriculum: ['آداب طالب العلم: خلاصة تعظيم العلم','العقيدة: البيضاء في عقيدة السلف','الحديث: الأربعون النووية وزيادة ابن رجب','الأخلاق والآداب: لامية ابن الوردي','مصطلح الحديث: المنظومة البيقونية','النحو: المقدمة الآجرومية','التفسير: الوجيز في التفسير','علوم القرآن: القول المنير','السيرة النبوية: الأرجوزة المئية','الفقه: العشماوية أو المختصر اللطيف أو بداية العابد وكفاية الزاهد'],
      admission: ['حفظ ثلاثة أجزاء من القرآن على الأقل','الجدية والاستمرار على الدروس والالتزام بقوانينها','ألا يقل عمر الطالب عن خمسة عشر عامًا'],
      completion: ['حضور الدروس العلمية: 35%','اجتياز الاختبارات لكل كتاب: 40%','حفظ المتون العلمية: 25%'],
      mandatory: ['العقيدة: البيضاء في عقيدة السلف','الحديث: الأربعون النووية مع زيادة ابن رجب'],
      complementary: ['الفقه: المرشد المعين أو مختصر أبي شجاع أو النظم الجلي','العقيدة: البيضاء في عقيدة السلف','المصطلح: البيقونية (34 بيتًا)','التزكية: لامية ابن الوردي (80 بيتًا)']
    },
    3: {
      image: 'brand-stage-rooting.png',
      planImage: 'stage-plan-3.png',
      books: [
        ['نخبة الفكر','مصطلح الحديث','book-r01.png'],
        ['أخصر المختصرات','الفقه الحنبلي','book-r02.png'],
        ['الصرف الصغير','الصرف','book-r03.png'],
        ['الوجيز في التفسير','التفسير','book-r04.png'],
        ['منظومة في القواعد الفقهية','القواعد الفقهية','book-r05.png'],
        ['سيرة النبي وسيرة أصحابه العشرة','السيرة النبوية','book-r06.png'],
        ['متممة الآجرومية','النحو','book-r07.png'],
        ['سلم الوصول إلى علم الأصول','العقيدة','book-r09.png'],
        ['الورقات','أصول الفقه','book-r10.png'],
        ['مدخل أهل الفقه واللسان','السلوك والتزكية','book-r11.png'],
        ['فتح القريب المجيب','الفقه الشافعي','book-r12.png'],
        ['زبدة البلاغة','البلاغة','book-r13.png'],
        ['تعليم المتعلم طريق التعلم','آداب طالب العلم','book-r14.png']
      ],
      intro: 'تركز هذه المرحلة على العمق والاستدلال؛ حيث ينتقل فيها المتعلم إلى مستوى أعلى من التحليل ودراسة الأدلة التفصيلية والمقارنات العلمية، بهدف ترسيخ الملكة العلمية وربط الجزئيات بالقواعد الكلية ومناقشتها.',
      duration: 'يوم واحد في الأسبوع من بعد صلاة العصر إلى بعد صلاة العشاء، بمعدل ثلاث ساعات، لمدة سنة دراسية من 10 أشهر.',
      plan: 'خطة دراسية بمعدل 150 ساعة.',
      curriculum: ['آداب طالب العلم: تعليم المتعلم طريق التعلم','العقيدة: سلم الوصول إلى علم الأصول','الحديث: الأربعون في الأحكام — عبادات ومعاملات','أصول الفقه: الورقات','السلوك والتزكية: مدخل أهل الفقه واللسان','القواعد الفقهية: منظومة القواعد الفقهية','السيرة النبوية: سيرة النبي وأصحابه العشرة','التفسير: الوجيز','الصرف: الصرف الصغير','الفقه: الرسالة أو القريب المجيب أو أخصر المختصرات'],
      admission: ['اجتياز المرحلة التأسيسية بمعدل لا يقل عن 75%','استيفاء الاختبارات والحضور وتسميع المتون'],
      completion: ['حضور الدروس العلمية: 35%','اجتياز الاختبارات لكل كتاب: 40%','حفظ المتون العلمية: 25%'],
      mandatory: ['السيرة: الأرجوزة المئية (100 بيت)','الفقه: المرشد المعين أو مختصر أبي شجاع أو النظم الجلي أو أخصر المختصرات','العقيدة: منظومة سلم الوصول إلى علم الأصول (290 بيتًا)'],
      complementary: ['القواعد الفقهية: نظم عثمان ابن سعد (43 بيتًا)','المصطلح: نخبة الفكر (74 سطرًا)','النحو: المقدمة الآجرومية (103 أسطر) أو نظمها (152 بيتًا)']
    },
    4: {
      image: 'brand-stage-achievement.png',
      planImage: 'stage-plan-4.png',
      books: [],
      intro: 'هي ذروة المسار التعليمي، وتهدف إلى جني الثمار من خلال التوسع في المسائل الدقيقة والنوازل المعاصرة؛ حيث يصل المتعلم فيها إلى مرحلة من النضج العلمي تمكنه من استحضار المسائل وتحصيل الفوائد واستنباط الأحكام.',
      duration: 'يومان في الأسبوع من بعد صلاة العصر إلى بعد صلاة العشاء، بمعدل ساعتين في اليوم، لمدة سنة دراسية من 10 أشهر.',
      plan: 'خطة دراسية بمعدل 150 ساعة.',
      curriculum: ['آداب طالب العلم: تذكرة السامع والمتكلم','العقيدة: العقيدة الواسطية','الحديث: جوامع الأخبار','السلوك والتزكية: بلوغ الغاية','النحو: متممة الآجرومية','البلاغة: دروس البلاغة','مصطلح الحديث: نخبة الفكر','متن اللغة: مثلث قطرب','الفقه — النكاح والجنايات: الرسالة أو القريب المجيب أو أخصر المختصرات'],
      admission: ['اجتياز المرحلة التأصيلية بمعدل لا يقل عن 75%','استيفاء الاختبارات والحضور وتسميع المتون'],
      completion: ['حضور الدروس العلمية: 35%','اجتياز الاختبارات لكل كتاب: 40%','حفظ المتون العلمية: 25%'],
      mandatory: ['النحو: المقدمة الآجرومية (103 أسطر) أو نظم عبيد ربه الشنقيطي (152 بيتًا)','الفقه: أسهل المسالك أو مختصر أبي شجاع أو النظم الجلي أو أخصر المختصرات','الحديث: الأربعون في الأحكام (40 حديثًا)'],
      complementary: ['المصطلح: نخبة الفكر (74 سطرًا)','السلوك والتزكية: لامية ابن الوردي (80 بيتًا)','أصول الفقه: الورقات (107 أسطر) أو نظمها للعمريطي (211 بيتًا)']
    }
  };
  const modal = document.querySelector('#stage-modal');
  if (!modal) return;
  document.querySelectorAll('.stage-card[data-stage]').forEach(card => card.addEventListener('click', () => {
    const item = stages[card.dataset.stage];
    const image = modal.querySelector('.modal-stage-logo-image');
    image.src = `assets/images/${item.image}`;
    image.alt = card.querySelector('h3')?.textContent || '';
    modal.querySelector('#stage-modal-text').textContent = item.intro;
    modal.querySelector('.modal-placeholder').innerHTML = `
      <div class="stage-facts">
        <section><small>وقت المرحلة ومدتها</small><strong>${item.duration}</strong></section>
        <section><small>الخطة الدراسية</small><strong>${item.plan}</strong></section>
      </div>
      <div class="stage-detail-columns">
        <section><h3>شروط الالتحاق</h3><ul>${item.admission.map(x => `<li>${x}</li>`).join('')}</ul></section>
        <section><h3>المطلوب لاجتياز المرحلة</h3><ul>${item.completion.map(x => `<li>${x}</li>`).join('')}</ul></section>
      </div>
      <div class="stage-plan-visual"><h3>الخطة الدراسية</h3><button class="stage-plan-image-button" type="button" aria-label="تكبير الخطة الدراسية"><img src="assets/images/${item.planImage}" alt="الخطة الدراسية"></button></div>
      <div class="stage-memorization"><h3>خطة الحفظ</h3><div class="memorization-columns"><section><h4>المتون الإلزامية</h4><ul>${item.mandatory.map(x => `<li>${x}</li>`).join('')}</ul></section><section><h4>المتون التكميلية</h4><ul>${item.complementary.map(x => `<li>${x}</li>`).join('')}</ul></section></div></div>
      ${item.books.length ? `<div class="stage-books"><div class="stage-books-heading"><div><small>مكتبة المرحلة</small><h3>الكتب والمقررات</h3></div><div class="stage-books-controls"><button type="button" data-books-prev aria-label="السابق"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button><button type="button" data-books-next aria-label="التالي"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button></div></div><div class="stage-books-track">${item.books.map(book => `<article class="stage-book-card"><img src="assets/images/${book[2]}" alt="${book[0]}"><small>${book[1]}</small><h4>${book[0]}</h4></article>`).join('')}</div></div>` : ''}`;
    const planButton = modal.querySelector('.stage-plan-image-button');
    planButton?.addEventListener('click', () => {
      const image = planButton.querySelector('img');
      const viewer = document.createElement('div');
      viewer.className = 'image-viewer open';
      viewer.innerHTML = `<button type="button" aria-label="إغلاق">×</button><img src="${image.src}" alt="${image.alt}">`;
      document.body.appendChild(viewer);
      const closeViewer = () => viewer.remove();
      viewer.addEventListener('click', event => { if (event.target === viewer || event.target.tagName === 'BUTTON') closeViewer(); });
    });
    const booksTrack = modal.querySelector('.stage-books-track');
    const bookStep = () => {
      const bookCards = booksTrack ? [...booksTrack.querySelectorAll('.stage-book-card')] : [];
      if (bookCards.length > 1) return bookCards[1].offsetLeft - bookCards[0].offsetLeft;
      return bookCards[0]?.getBoundingClientRect().width || 300;
    };
    modal.querySelector('[data-books-prev]')?.addEventListener('click', () => booksTrack.scrollBy({left: bookStep(),behavior:'smooth'}));
    modal.querySelector('[data-books-next]')?.addEventListener('click', () => booksTrack.scrollBy({left: -bookStep(),behavior:'smooth'}));
  }));
});

// Inline feedback for services that are still being prepared.
(() => {
  const toast = document.createElement('div');
  toast.className = 'soon-toast';
  toast.setAttribute('role', 'status');
  document.body.appendChild(toast);
  let timer;
  document.querySelectorAll('[data-soon]').forEach(button => button.addEventListener('click', () => {
    toast.textContent = `${button.dataset.soon} — انتظرونا قريبًا`;
    toast.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => toast.classList.remove('show'), 2400);
  }));
})();

// Rotating "فتاوى مختارة" widget — reads assets/data/fatawa.json (a snapshot of the "fatawa" sheet of the basaer-REF workbook, served by this site), with a fallback sample set until it loads.
document.addEventListener('DOMContentLoaded', () => {
  const ticker = document.querySelector('#fatwa-ticker');
  if (!ticker) return;
  const viewport = ticker.querySelector('.fatwa-viewport');
  const layers = [...ticker.querySelectorAll('.fatwa-layer')];
  const prevBtn = ticker.querySelector('[data-fatwa-prev]');
  const nextBtn = ticker.querySelector('[data-fatwa-next]');
  const toggleBtn = ticker.querySelector('[data-fatwa-toggle]');
  const tagsBox = document.querySelector('#fatwa-tags');

  // Snapshot of the "fatawa" sheet (rows of {title, question, answer, category}), kept on
  // this server next to the other site assets; edit that file to change the fatawa.
  const FATAWA_URL = 'assets/data/fatawa.json';

  const FALLBACK = [
    { title: 'حكم الجمع بين الصلاتين للمسافر', question: 'هل يجوز للمسافر أن يجمع بين الظهر والعصر وبين المغرب والعشاء؟', answer: 'نعم، يجوز للمسافر سفرًا تُقصر فيه الصلاة أن يجمع بين الظهر والعصر تقديمًا أو تأخيرًا، وبين المغرب والعشاء كذلك؛ تخفيفًا عنه ورفعًا للحرج.', category: 'الصلاة' },
    { title: 'زكاة الحلي المستعمل', question: 'هل تجب الزكاة في الذهب الذي تلبسه المرأة للزينة؟', answer: 'الراجح وجوب زكاة الحلي إذا بلغ النصاب وحال عليه الحول، ولو كان مُعدًّا للاستعمال؛ لعموم الأدلة الموجبة لزكاة الذهب والفضة.', category: 'الزكاة' },
    { title: 'حكم صيام من نوى الصيام بعد الفجر', question: 'استيقظت بعد أذان الفجر ولم أكن نويت الصيام، فهل يصح صيامي؟', answer: 'صيام الفرض لا يصح إلا بنية من الليل قبل طلوع الفجر، فمن استيقظ بعد الفجر ولم يكن نوى فعليه أن يمسك ذلك اليوم ويقضيه.', category: 'الصيام' }
  ];

  const escapeHtml = str => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const slideMarkup = item => `<h4 class="fatwa-title">${escapeHtml(item.title)}</h4><p class="fatwa-question"><span>السؤال:</span> ${escapeHtml(item.question)}</p><p class="fatwa-answer">${escapeHtml(item.answer)}</p>`;
  const readDuration = item => Math.min(16000, Math.max(6500, (item.title.length + item.question.length + item.answer.length) * 55));

  let allItems = FALLBACK, items = FALLBACK, activeCategory = null;
  let index = 0, activeLayer = layers[0], paused = false, timer = null, heightTimer = null;

  function growViewport(neededHeight) {
    const currentHeight = viewport.getBoundingClientRect().height;
    viewport.style.minHeight = Math.max(neededHeight, currentHeight) + 'px';
    clearTimeout(heightTimer);
    heightTimer = setTimeout(() => { viewport.style.minHeight = neededHeight + 'px'; }, 650);
  }

  function render(newIndex, direction) {
    const incoming = activeLayer === layers[0] ? layers[1] : layers[0];
    incoming.innerHTML = slideMarkup(items[newIndex]);
    incoming.style.transition = 'none';
    incoming.style.transform = direction === 'next' ? 'translateY(100%)' : 'translateY(-100%)';
    void incoming.offsetWidth;
    incoming.style.transition = '';
    growViewport(incoming.scrollHeight);
    activeLayer.classList.remove('is-active');
    incoming.classList.add('is-active');
    requestAnimationFrame(() => {
      activeLayer.style.transform = direction === 'next' ? 'translateY(-100%)' : 'translateY(100%)';
      incoming.style.transform = 'translateY(0)';
    });
    activeLayer = incoming;
    index = newIndex;
  }

  function scheduleNext() {
    clearTimeout(timer);
    if (paused || items.length < 2) return;
    timer = setTimeout(() => go(1, 'next'), readDuration(items[index]));
  }

  function go(step, direction) {
    render((index + step + items.length) % items.length, direction);
    scheduleNext();
  }

  function start(list) {
    items = list && list.length ? list : allItems;
    index = 0;
    layers.forEach(l => l.classList.remove('is-active'));
    activeLayer = layers[0];
    activeLayer.style.transition = 'none';
    activeLayer.style.transform = 'translateY(0)';
    activeLayer.innerHTML = slideMarkup(items[0]);
    void activeLayer.offsetWidth;
    activeLayer.style.transition = '';
    activeLayer.classList.add('is-active');
    clearTimeout(heightTimer);
    viewport.style.minHeight = activeLayer.scrollHeight + 'px';
    scheduleNext();
  }

  function renderTags() {
    if (!tagsBox) return;
    const categories = [...new Set(allItems.map(i => i.category).filter(Boolean))];
    const clearBtn = `<button type="button" class="tag-clear"${activeCategory ? '' : ' disabled'} aria-label="عرض جميع الفتاوى"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
    const tagBtns = categories.map(cat => `<button type="button" class="tag-btn${cat === activeCategory ? ' is-active' : ''}" data-tag="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`).join('');
    tagsBox.innerHTML = clearBtn + tagBtns;
  }

  function applyFilter(category) {
    activeCategory = category;
    renderTags();
    start(category ? allItems.filter(i => i.category === category) : allItems);
  }

  tagsBox?.addEventListener('click', event => {
    if (event.target.closest('.tag-clear')) { applyFilter(null); return; }
    const tagBtn = event.target.closest('.tag-btn');
    if (tagBtn) applyFilter(tagBtn.dataset.tag);
  });

  nextBtn?.addEventListener('click', () => go(1, 'next'));
  prevBtn?.addEventListener('click', () => go(-1, 'prev'));
  toggleBtn?.addEventListener('click', () => {
    paused = !paused;
    toggleBtn.setAttribute('aria-label', paused ? 'تشغيل التبديل التلقائي' : 'إيقاف التبديل التلقائي');
    toggleBtn.innerHTML = paused ? '<i class="fa-solid fa-play" aria-hidden="true"></i>' : '<i class="fa-solid fa-pause" aria-hidden="true"></i>';
    if (paused) clearTimeout(timer); else scheduleNext();
  });

  renderTags();
  start(allItems);

  // The fatawa used to be read straight from a public Google Sheet through a docs.google.com
  // <script> (JSONP). A script from another origin running on this site's origin is not
  // acceptable now that the site and the app share it, so the rows come from a local file
  // instead; while it loads, or if it is missing, the built-in sample set stays on screen.
  fetch(FATAWA_URL, { cache: 'no-cache' })
    .then(response => (response.ok ? response.json() : []))
    .then(rows => {
      const live = (Array.isArray(rows) ? rows : []).map(r => ({
        title: r.title || '',
        question: r.question || '',
        answer: r.answer || '',
        category: r.category || ''
      })).filter(item => item.title && item.question && item.answer);
      if (live.length) {
        allItems = live;
        activeCategory = null;
        renderTags();
        start(allItems);
      }
    })
    .catch(() => {});
});

// Rotating "من كلمات الطلاب" widget — same rotating-card mechanism as the fatawa widget above. Sample quotes until real ones are supplied.
document.addEventListener('DOMContentLoaded', () => {
  const ticker = document.querySelector('#student-ticker');
  if (!ticker) return;
  const viewport = ticker.querySelector('.fatwa-viewport');
  const layers = [...ticker.querySelectorAll('.fatwa-layer')];
  const prevBtn = ticker.querySelector('[data-quote-prev]');
  const nextBtn = ticker.querySelector('[data-quote-next]');
  const toggleBtn = ticker.querySelector('[data-quote-toggle]');

  const QUOTES = [
    { text: 'الحمد لله والصلاة والسلام على رسول الله، أما بعد... فهذه رسالة شكر من القلب إلى بصائر وإدارتها ومن فيها من الشيوخ، أعبر فيها عن سروري وفرحي العظيم بهذه الدورة التي طالما تمنيت مثلها في أن يصل لي أحد المتون المختصرة للعلوم الشرعية، وقد حققت هذه الدورة أمنيتي، ولله الحمد والمنة، وأسأل الله أن يبارك لكل من ساهم فيها وأن يوفقه للخير ويغفر له ويجزيه خيرًا ويرفع درجته في الجنة، والله أعلم.' },
    { text: 'أحسن الله إليكم وجزاكم خيرًا على هذا البرنامج المبارك الطيب، استفدنا بشكل كبير على الرغم من دراستنا للمواد الشرعية السابقة. أشكر الشيوخ الأفاضل على حسن شرحهم وصدق نيتهم لإيصال العلم، كانت مجالس بصائر بالنسبة لنا طلب علم واجتماع طيب بعد أسبوع ثقيل، بثّ في أنفسنا الراحة والطمأنينة، ونشعر بالسكينة والطمأنينة ونزداد علمًا بربنا وديننا.' },
    { text: 'جزاكم الله خيرًا، جزاكم الله الجنة وتقبل الله منكم، استفدنا الكثير، ولله الحمد، أسأل الله أن لا يكون حجة لنا علينا، وأن نحمل الرسالة التي أعطيتمونا إياها إلى الأجيال القادمة.' },
    { text: 'أحب أشكر برنامج بصائر على نخبة المشايخ اللي اختاروهم، وطريقة توزيعهم الوقت بحيث خلّصنا عشرة كتب قراءة ودراسة في سنة واحدة.' },
    { text: 'جزاكم الله عنا خير الجزاء، ونفعنا وإياكم بهذه المجالس، وأسأل الله أن تكون لنا حجة لا علينا. عن أبي أمامة رضي الله عنه أن رسول الله ﷺ قال: «فضل العالم على العابد كفضلي على أدناكم» ثم قال رسول الله ﷺ: «إن الله وملائكته وأهل السماوات والأرض حتى النملة في جحرها وحتى الحوت ليصلّون على معلّمي الناس الخير» رواه الترمذي وقال: حديث حسن. على أن نلقاكم في المستوى القادم قريبًا بإذن الله.' },
    { text: 'شكرًا لكم من القلب، سهّلتم لنا طريق العلم نحن النساء.. نحن نحيطكم بدعائنا دائمًا، جزاكم الله عنا خير الجزاء.' },
    { text: 'جزاكم الله عنا خير الجزاء ونفع الله بعلمكم، كفيتوا ووفيتوا من التنظيم إلى المناهج، تجربة رائدة فريدة من نوعها والأولى في مملكة البحرين.' },
    { text: 'شكرًا لهذا البرنامج المبارك الذي أضاء لنا دروب الفهم، وربطنا بأصول الشريعة بروح علمية وإيمانية راقية. كانت بصائر بحق نافذة نور، ورسالة هداية، نسأل الله أن يبارك في القائمين عليه ويكتب لهم أجر كل مستفيد.' },
    { text: 'برنامج بصائر أثّر فيّ بشكل كبير من ناحية قربي من ربي، ومن ناحية التزامي بالسلوك الشرعي؛ تأثرت بأخواتي في لبسهن، جزاهن الله خيرًا.' }
  ];

  const escapeHtml = str => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const slideMarkup = item => `<p class="quote-text">“${escapeHtml(item.text)}”</p>`;
  const readDuration = item => Math.min(18000, Math.max(7000, item.text.length * 55));

  const items = QUOTES;
  let index = 0, activeLayer = layers[0], paused = false, timer = null, heightTimer = null;

  function growViewport(neededHeight) {
    const currentHeight = viewport.getBoundingClientRect().height;
    viewport.style.minHeight = Math.max(neededHeight, currentHeight) + 'px';
    clearTimeout(heightTimer);
    heightTimer = setTimeout(() => { viewport.style.minHeight = neededHeight + 'px'; }, 650);
  }

  function render(newIndex, direction) {
    const incoming = activeLayer === layers[0] ? layers[1] : layers[0];
    incoming.innerHTML = slideMarkup(items[newIndex]);
    incoming.style.transition = 'none';
    incoming.style.transform = direction === 'next' ? 'translateY(100%)' : 'translateY(-100%)';
    void incoming.offsetWidth;
    incoming.style.transition = '';
    growViewport(incoming.scrollHeight);
    activeLayer.classList.remove('is-active');
    incoming.classList.add('is-active');
    requestAnimationFrame(() => {
      activeLayer.style.transform = direction === 'next' ? 'translateY(-100%)' : 'translateY(100%)';
      incoming.style.transform = 'translateY(0)';
    });
    activeLayer = incoming;
    index = newIndex;
  }

  function scheduleNext() {
    clearTimeout(timer);
    if (paused || items.length < 2) return;
    timer = setTimeout(() => go(1, 'next'), readDuration(items[index]));
  }

  function go(step, direction) {
    render((index + step + items.length) % items.length, direction);
    scheduleNext();
  }

  nextBtn?.addEventListener('click', () => go(1, 'next'));
  prevBtn?.addEventListener('click', () => go(-1, 'prev'));
  toggleBtn?.addEventListener('click', () => {
    paused = !paused;
    toggleBtn.setAttribute('aria-label', paused ? 'تشغيل التبديل التلقائي' : 'إيقاف التبديل التلقائي');
    toggleBtn.innerHTML = paused ? '<i class="fa-solid fa-play" aria-hidden="true"></i>' : '<i class="fa-solid fa-pause" aria-hidden="true"></i>';
    if (paused) clearTimeout(timer); else scheduleNext();
  });

  activeLayer.innerHTML = slideMarkup(items[0]);
  activeLayer.classList.add('is-active');
  viewport.style.minHeight = activeLayer.scrollHeight + 'px';
  scheduleNext();
});

// Footer "تواصل معنا" modal — submits via Web3Forms (web3forms.com) so a static site can email without a custom backend.
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.querySelector('#contact-modal');
  const trigger = document.querySelector('#contact-trigger');
  const form = document.querySelector('#contact-form');
  const status = document.querySelector('#contact-status');
  if (!modal || !trigger || !form) return;

  const open = () => { modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden'; };
  const close = () => { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; };

  trigger.addEventListener('click', open);
  modal.querySelector('.modal-close')?.addEventListener('click', close);
  modal.querySelector('.modal-backdrop')?.addEventListener('click', close);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && modal.classList.contains('open')) close(); });

  const RULES = {
    name: { required: true, test: v => /^[ء-ي\s]+$/.test(v.trim()), message: 'الاسم يجب أن يكون باللغة العربية فقط' },
    phone: { required: false, test: v => /^[0-9]{9}$/.test(v.trim()), message: 'الرقم الشخصي يجب أن يتكوّن من 9 أرقام' },
    email: { required: true, test: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()), message: 'يرجى إدخال بريد إلكتروني صحيح' },
    message: { required: true, test: v => v.trim().length > 0, message: 'يرجى كتابة رسالتك' }
  };

  function validateField(field) {
    const rule = RULES[field.name];
    if (!rule) return true;
    const value = field.value;
    const empty = value.trim() === '';
    const errorEl = field.closest('label')?.querySelector('.field-error');
    let valid = true, msg = '';
    if (empty && rule.required) { valid = false; msg = 'هذا الحقل مطلوب'; }
    else if (!empty && !rule.test(value)) { valid = false; msg = rule.message; }
    field.classList.toggle('is-invalid', !valid);
    if (errorEl) errorEl.textContent = valid ? '' : msg;
    return valid;
  }

  const validatedFields = [...form.querySelectorAll('input[name],textarea[name]')].filter(f => RULES[f.name]);
  validatedFields.forEach(field => {
    field.addEventListener('blur', () => validateField(field));
    field.addEventListener('input', () => { if (field.classList.contains('is-invalid')) validateField(field); });
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submitBtn = form.querySelector('.contact-submit');
    status.textContent = '';
    status.className = 'contact-status';

    const allValid = validatedFields.map(validateField).every(Boolean);
    if (!allValid) {
      status.textContent = 'يرجى تصحيح الأخطاء في النموذج قبل الإرسال.';
      status.classList.add('is-error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'جارٍ الإرسال...';
    try {
      const response = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });
      const result = await response.json();
      if (result.success) {
        status.textContent = 'تم إرسال رسالتك بنجاح، شكرًا لتواصلك معنا.';
        status.classList.add('is-success');
        form.reset();
        validatedFields.forEach(field => { field.classList.remove('is-invalid'); const e = field.closest('label')?.querySelector('.field-error'); if (e) e.textContent = ''; });
        setTimeout(close, 1800);
      } else {
        throw new Error(result.message || 'تعذّر الإرسال');
      }
    } catch (err) {
      status.textContent = 'تعذّر إرسال الرسالة، حاول مرة أخرى أو راسلنا مباشرة عبر واتساب.';
      status.classList.add('is-error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'إرسال';
    }
  });
});

// Public navigation for the approved homepage structure.
(() => {
  const nav = document.querySelector('.main-nav');
  if (!nav) return;
  nav.innerHTML = `
    <a class="active" href="#top">الرئيسية</a>
    <a href="#about">عن بصائر</a>
    <a href="#stages">المراحل الدراسية</a>
    <a href="#courses">البرامج المكملة</a>
    <a href="#testimonials">قالوا عنا</a>
    <a href="#services">الخدمات</a>
    <a href="#faq">الأسئلة الشائعة</a>
    <a class="nav-login" href="platform.html">تسجيل الدخول</a>`;
})();
