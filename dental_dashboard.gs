// ==========================================
// 三井牙科體系 · 診所管理儀表板
// dental_dashboard.gs — Google Apps Script
// ==========================================

var CLINIC_NAMES = ['林口', '忠孝', '巨蛋', '頭等艙', '波音'];
var CLINIC_COLORS = {
  '林口':   '#1D9E75',
  '忠孝':   '#7F77DD',
  '巨蛋':   '#378ADD',
  '頭等艙': '#BA7517',
  '波音':   '#D85A30'
};

var TREATMENT_MAP = [
  { label: '全口重建', keys: ['全口重建', '咬合重建'] },
  { label: '植牙',     keys: ['植牙', '植體', 'implant', 'Implant'] },
  { label: '矯正',     keys: ['矯正', '牙套', '隱適美', 'invisalign', 'Invisalign'] },
  { label: '根管',     keys: ['根管', '抽神經', 'RCT'] },
  { label: '牙周',     keys: ['牙周', '牙齦'] },
  { label: '假牙/冠',  keys: ['假牙', '牙冠', '全冠', '嵌體', '貼片'] },
  { label: '拔牙',     keys: ['拔牙', '拔除', '智齒'] },
  { label: '補牙',     keys: ['補牙', '填補', '樹脂'] },
  { label: '美白/特殊',keys: ['美白', '漂白'] },
  { label: '全口檢查', keys: ['全口檢查', '初診', '初檢'] },
  { label: '洗牙/定檢',keys: ['洗牙', '定檢', '例行', '牙結石'] },
  { label: '新患者',   keys: ['NP'] }
];

var INVALID_TITLE_KEYS = ['勿約診', '擋約'];
var INVALID_DESC_KEYS  = ['勿約診', '勿約', '接現場', '只看現掛', '治療診', '假日勿約'];

// Per-execution calendar ID cache (avoids repeated getAllCalendars() calls)
var _calCache = {};

// ── Entry Point ──────────────────────────────────────────────
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('三井牙科體系 · 診所管理儀表板')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── Calendar ID 取得（含自動偵測）──────────────────────────────
function getCalendarId(clinicName) {
  if (_calCache[clinicName] !== undefined) return _calCache[clinicName];
  var props = PropertiesService.getScriptProperties();
  var keyMap = { '林口':'CAL_LINKOU','忠孝':'CAL_ZHONGXIAO','巨蛋':'CAL_JUEDAN','頭等艙':'CAL_FIRST','波音':'CAL_BOEING' };

  // 1. Script Properties 優先
  var stored = props.getProperty(keyMap[clinicName]) || '';
  if (stored) { _calCache[clinicName] = stored; return stored; }

  // 2. 自動掃描所有可存取日曆（名稱含診所名）
  try {
    var all = CalendarApp.getAllCalendars();
    for (var i = 0; i < all.length; i++) {
      if (all[i].getName().indexOf(clinicName) >= 0) {
        var id = all[i].getId();
        _calCache[clinicName] = id;
        props.setProperty(keyMap[clinicName], id);
        console.log('[AutoDetect] ' + clinicName + ' → ' + all[i].getName());
        return id;
      }
    }
  } catch(e) { console.log('[AutoDetect error] ' + clinicName + ': ' + e.message); }

  _calCache[clinicName] = '';
  return '';
}

// ── 工具函式 ──────────────────────────────────────────────────
function formatDate(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth()+1) + '-' + pad2(date.getDate());
}
function parseDate(s) { var p=s.split('-'); return new Date(+p[0],+p[1]-1,+p[2]); }
function pad2(n) { return String(n).padStart(2,'0'); }
function formatTime(d) { return pad2(d.getHours())+':'+pad2(d.getMinutes()); }
function daysBetween(a,b) { return Math.floor(Math.abs(b-a)/86400000); }
function getShift(h) {
  if (h>=9&&h<13) return '早';
  if (h>=13&&h<18) return '午';
  if (h>=18) return '晚';
  return '';
}

// ── 解析收費 ─────────────────────────────────────────────────
function parseAmount(text) {
  if (!text) return 0;
  var t = String(text), total = 0;
  // *NW[M] → N×10000 + M×1000  (e.g. *2W5=25000)
  t.replace(/\*(\d+\.?\d*)W(\d*)/gi, function(_,a,b){ total += Math.round(parseFloat(a)*10000)+(b?+b*1000:0); });
  // *NT → N×1000
  t.replace(/\*(\d+\.?\d*)T\b/gi, function(_,a){ total += Math.round(parseFloat(a)*1000); });
  // *NB → N×100
  t.replace(/\*(\d+\.?\d*)B\b/gi, function(_,a){ total += Math.round(parseFloat(a)*100); });
  // inv$N
  t.replace(/inv\$(\d+)/gi, function(_,a){ total += +a; });
  // 收N
  t.replace(/收(\d+)/g, function(_,a){ total += +a; });
  // *N (4+ digits pure number, not followed by T/W/B)
  t.replace(/\*(\d{4,})\b(?![TWBtwb])/g, function(_,a){ total += +a; });
  return total;
}

// ── 有效約診判斷 ──────────────────────────────────────────────
function isValidAppointment(title, desc, startTime) {
  title=title||''; desc=desc||'';
  for (var i=0;i<INVALID_TITLE_KEYS.length;i++) if(title.indexOf(INVALID_TITLE_KEYS[i])>=0) return false;
  for (var j=0;j<INVALID_DESC_KEYS.length;j++) if(desc.indexOf(INVALID_DESC_KEYS[j])>=0) return false;
  // 使用 Asia/Taipei 時區判斷，避免 GAS 專案時區設定錯誤導致正常約診被過濾
  if (startTime) {
    try {
      var h = parseInt(Utilities.formatDate(startTime, 'Asia/Taipei', 'H'), 10);
      if (h < 8) return false;
    } catch(e) {
      if (startTime.getHours() < 8) return false;
    }
  }
  return true;
}

// ── NP 判斷 ───────────────────────────────────────────────────
function isNP(title, desc) {
  title=title||''; desc=desc||'';
  return /^NP\b/.test(title) || title==='NP' || desc.indexOf('NP')>=0;
}

// ── 解析患者姓名（/姓名生日 格式）──────────────────────────────
function parsePatientName(desc) {
  if (!desc) return '';
  var m = desc.match(/\/([^\d\/\s]{1,6})\d{4,}/);
  if (m) return m[1];
  m = desc.match(/\/([^\d\/\s\n]{1,8})/);
  if (m) return m[1].trim();
  return '';
}

// ── NP 來源 ───────────────────────────────────────────────────
function getNPSource(desc) {
  desc=desc||'';
  if (desc.indexOf('波音OP')>=0) return '波音轉介';
  if (desc.indexOf('三井OP')>=0) return '體系OP';
  return '外部全新';
}

// ── 療程分類 ──────────────────────────────────────────────────
function parseTreatmentType(title, desc) {
  var text=(title||'')+' '+(desc||'');
  for (var i=0;i<TREATMENT_MAP.length;i++) {
    var t=TREATMENT_MAP[i];
    for (var j=0;j<t.keys.length;j++) if(text.indexOf(t.keys[j])>=0) return t.label;
  }
  return '其他';
}

// ── 解析最後就診日 ─────────────────────────────────────────────
function parseLastVisitDate(desc) {
  if (!desc) return null;
  var m=desc.match(/最後就診日[：:]\s*(\d{4}-\d{2}-\d{2})/);
  return m?m[1]:null;
}

// ── 就診原因 ──────────────────────────────────────────────────
function extractReason(desc) {
  if (!desc) return '';
  var m=(desc.match(/主訴[：:]\s*([^\n]{2,20})/) ||
         desc.match(/原因[：:]\s*([^\n]{2,20})/));
  return m?m[1].trim():'';
}

// ── 醫師名提取 ───────────────────────────────────────────────
function extractDoctorName(title, desc) {
  desc=desc||''; title=title||'';
  var m=desc.match(/醫師[：:]\s*([^\s\n,，、]{2,5})/);
  if (m) return m[1];
  m=desc.match(/Dr[\.：:]\s*([^\s\n,，]{2,5})/i);
  if (m) return m[1];
  m=title.match(/^([^\s\/]{2,5})[\/＼]/);
  if (m) return m[1];
  return '';
}

// ── 從 Google Calendar 取事件 ────────────────────────────────
function fetchClinicEvents(clinicName, date) {
  var calId=getCalendarId(clinicName);
  if (!calId) return [];
  var s=new Date(date.getFullYear(),date.getMonth(),date.getDate(),0,0,0);
  var e=new Date(date.getFullYear(),date.getMonth(),date.getDate(),23,59,59);
  try {
    var cal=CalendarApp.getCalendarById(calId);
    if (!cal) return [];
    return cal.getEvents(s,e).map(function(ev){
      return { title:ev.getTitle()||'', desc:ev.getDescription()||'', start:ev.getStartTime(), end:ev.getEndTime() };
    });
  } catch(err) {
    console.log('Calendar error '+clinicName+': '+err.message);
    return [];
  }
}

// ── 快速統計（不做完整解析，避免遞迴）──────────────────────────
function getQuickKPI(dateStr) {
  var date=parseDate(dateStr);
  var total=0,amount=0,np=0,docSet={};
  CLINIC_NAMES.forEach(function(name){
    fetchClinicEvents(name,date).forEach(function(ev){
      if (!isValidAppointment(ev.title,ev.desc,ev.start)) return;
      total++;
      amount+=parseAmount(ev.desc);
      if (isNP(ev.title,ev.desc)) np++;
      var dr=extractDoctorName(ev.title,ev.desc)||'值班';
      docSet[name+':'+dr]=true;
    });
  });
  return { totalAppointments:total, totalAmount:amount, npCount:np, workingDoctors:Object.keys(docSet).length };
}

// ── 核心：單日資料 ───────────────────────────────────────────
function getDayData(dateStr) {
  var date=parseDate(dateStr);
  var now=new Date();
  var lwsd=new Date(date.getTime()-7*864e5); // 上週同日
  var yday=new Date(date.getTime()-864e5);   // 昨日

  var out={
    date:dateStr,
    kpi:{ totalAppointments:0, totalAmount:0, npCount:0, workingDoctors:0 },
    kpiYesterday:getQuickKPI(formatDate(yday)),
    clinics:[],
    heatmapData:[],
    doctorRanking:[],
    treatmentPie:{},
    npList:[],
    feeList:[],
    reminders:{ pending:[], cancelled:[], longNoVisit:[] },
    rescheduling:[],
    alerts:[]
  };

  CLINIC_NAMES.forEach(function(clinicName){
    var events=fetchClinicEvents(clinicName,date);
    var lwsdEvents=fetchClinicEvents(clinicName,lwsd);
    var color=CLINIC_COLORS[clinicName];
    var doctorMap={};

    events.forEach(function(ev){
      var valid=isValidAppointment(ev.title,ev.desc,ev.start);
      var dr=extractDoctorName(ev.title,ev.desc)||'值班醫師';
      if (!doctorMap[dr]) doctorMap[dr]={ name:dr, clinic:clinicName, color:color, all:[], valid:[], amount:0, hourly:{}, shiftSet:{} };
      doctorMap[dr].all.push(ev);
      if (!valid) return;

      var h; try { h=parseInt(Utilities.formatDate(ev.start,'Asia/Taipei','H'),10); } catch(e2){ h=ev.start.getHours(); }
      var shift=getShift(h);
      var timeStr=pad2(h)+':'+pad2(ev.start.getMinutes());
      var amt=parseAmount(ev.desc);
      var npFlag=isNP(ev.title,ev.desc);
      var patName=parsePatientName(ev.desc)||ev.title;
      var treatment=parseTreatmentType(ev.title,ev.desc);
      var desc=ev.desc||'';

      doctorMap[dr].valid.push(ev);
      doctorMap[dr].amount+=amt;
      doctorMap[dr].hourly[h]=(doctorMap[dr].hourly[h]||0)+1;
      if(shift) doctorMap[dr].shiftSet[shift]=true;

      out.treatmentPie[treatment]=(out.treatmentPie[treatment]||0)+1;

      if (npFlag) {
        out.npList.push({ name:patName, source:getNPSource(desc), reason:extractReason(desc), clinic:clinicName, doctor:dr, time:timeStr, desc:desc });
      }
      if (amt>0) {
        out.feeList.push({ patientName:patName, amount:amt, clinic:clinicName, doctor:dr, time:timeStr, treatment:treatment, isVP:desc.indexOf('VP')>=0, desc:desc });
      }

      // 提醒
      var pendingKeys=['時間尚未確定','時間確認中','賴改約','未接','已傳簡訊'];
      var cancelKeys=['患者取消','診所改約'];
      if (pendingKeys.some(function(k){return desc.indexOf(k)>=0;}) && (ev.start<now||h<9)) {
        out.reminders.pending.push({ patient:patName, reason:extractReason(desc), clinic:clinicName, doctor:dr, time:timeStr });
      }
      if (cancelKeys.some(function(k){return desc.indexOf(k)>=0;})) {
        out.reminders.cancelled.push({ patient:patName, reason:extractReason(desc), clinic:clinicName, doctor:dr, time:timeStr });
      }
      var lvDate=parseLastVisitDate(desc);
      if (lvDate && daysBetween(new Date(lvDate),now)>300) {
        out.reminders.longNoVisit.push({ patient:patName, lastVisitDate:lvDate, daysSince:daysBetween(new Date(lvDate),now), clinic:clinicName, doctor:dr, time:timeStr });
      }

      // 改約
      var reschedKeys=['改約','改1','改2','改3','未接'];
      if (reschedKeys.some(function(k){return desc.indexOf(k)>=0;})) {
        var cnt=0;
        var mm=desc.match(/改(\d)/g);
        if (mm) mm.forEach(function(x){cnt=Math.max(cnt,+x[1]);});
        if (cnt===0) cnt=1;
        out.rescheduling.push({ patient:patName, count:cnt, clinic:clinicName, doctor:dr, time:timeStr });
      }
    });

    var lwsdCount=lwsdEvents.filter(function(ev){return isValidAppointment(ev.title,ev.desc,ev.start);}).length;
    var workingDocs=[];

    Object.keys(doctorMap).forEach(function(dName){
      var doc=doctorMap[dName];
      if (doc.valid.length===0) return;
      var seen={}, specialties=[];
      doc.valid.forEach(function(ev){ var t=parseTreatmentType(ev.title,ev.desc); if(t!=='其他'&&!seen[t]){seen[t]=true;specialties.push(t);} });
      var sc=Object.keys(doc.shiftSet).length||1;
      workingDocs.push({ name:dName, clinic:clinicName, color:color, sessions:doc.valid.length, amount:doc.amount, specialties:specialties, hourly:doc.hourly, shiftCount:sc });
      out.doctorRanking.push({ name:dName, clinic:clinicName, color:color, sessions:doc.valid.length, amount:doc.amount, shiftCount:sc });
      out.heatmapData.push({ clinic:clinicName, doctor:dName, color:color, hourly:doc.hourly });
      out.kpi.workingDoctors++;
    });

    var clinicTotal=workingDocs.reduce(function(s,d){return s+d.sessions;},0);
    var clinicAmount=workingDocs.reduce(function(s,d){return s+d.amount;},0);
    var clinicNP=out.npList.filter(function(n){return n.clinic===clinicName;}).length;

    out.clinics.push({ name:clinicName, color:color, totalAppointments:clinicTotal, totalAmount:clinicAmount, npCount:clinicNP, lastWeekSameDay:lwsdCount, doctors:workingDocs });
    out.kpi.totalAppointments+=clinicTotal;
    out.kpi.totalAmount+=clinicAmount;
    out.kpi.npCount+=clinicNP;
  });

  out.feeList.sort(function(a,b){return b.amount-a.amount;});
  out.doctorRanking.sort(function(a,b){return b.amount-a.amount;});
  out.alerts=buildAlerts(out,date,now);
  return out;
}

// ── 異常警示 ──────────────────────────────────────────────────
function buildAlerts(data, date, now) {
  var alerts=[];

  // 跨院時段衝突
  var dcMap={};
  data.heatmapData.forEach(function(d){
    if (!dcMap[d.doctor]) dcMap[d.doctor]={};
    Object.keys(d.hourly).forEach(function(h){
      if (!dcMap[d.doctor][h]) dcMap[d.doctor][h]=[];
      dcMap[d.doctor][h].push(d.clinic);
    });
  });
  Object.keys(dcMap).forEach(function(dr){
    Object.keys(dcMap[dr]).forEach(function(h){
      var cs=dcMap[dr][h];
      if (cs.length>=2) alerts.push({ level:'red', msg:dr+' '+cs[0]+' '+pad2(h)+':00 與 '+cs[1]+' '+pad2(h)+':00 時段衝突' });
    });
  });

  // 高單價未確認
  data.feeList.forEach(function(f){
    if (f.amount>30000 && f.desc.indexOf('已付清')<0 && f.desc.indexOf('已收')<0 && f.desc.indexOf('付清')<0) {
      alerts.push({ level:'orange', msg:f.patientName+' $'+f.amount.toLocaleString()+' · '+f.clinic+'·'+f.doctor+' 需確認收款狀態' });
    }
  });

  // NP急診
  var urgKeys=['牙痛','牙腫','腫','長牙胞','牙裂','急'];
  data.npList.forEach(function(np){
    if (urgKeys.some(function(k){return (np.desc||'').indexOf(k)>=0;})) {
      alerts.push({ level:'orange', msg:np.name+' 急診NP · '+np.clinic+'·'+np.doctor+' 建議安排回診' });
    }
  });

  // 取消≥3
  if (data.reminders.cancelled.length>=3) {
    alerts.push({ level:'orange', msg:'今日已取消/改約 '+data.reminders.cancelled.length+' 筆，建議追蹤到診狀況' });
  }

  // NP比例>25%
  data.clinics.forEach(function(c){
    if (c.totalAppointments>0 && c.npCount/c.totalAppointments>0.25) {
      alerts.push({ level:'orange', msg:c.name+' NP佔比 '+Math.round(c.npCount/c.totalAppointments*100)+'%，建議確認後續回診安排' });
    }
  });

  // 約診量較上週低30%
  data.clinics.forEach(function(c){
    if (c.lastWeekSameDay>0) {
      var drop=(c.lastWeekSameDay-c.totalAppointments)/c.lastWeekSameDay;
      if (drop>=0.3) alerts.push({ level:'orange', msg:c.name+' 今日 '+c.totalAppointments+' 筆，較上週同期低 '+Math.round(drop*100)+'%' });
    }
  });

  // 連續3天無資料
  CLINIC_NAMES.forEach(function(name){
    var noData=true;
    for (var i=0;i<3;i++){
      var d=new Date(date.getTime()-i*864e5);
      if (d.getDay()===0||d.getDay()===6) continue;
      try {
        var evs=fetchClinicEvents(name,d);
        if (evs.filter(function(ev){return isValidAppointment(ev.title,ev.desc,ev.start);}).length>0){noData=false;break;}
      } catch(e){}
    }
    if (noData) alerts.push({ level:'red', msg:name+' 連續3天無約診資料，請確認同步狀態' });
  });

  return alerts;
}

// ── 週資料 ───────────────────────────────────────────────────
function getWeekData(dateStr) {
  var date=parseDate(dateStr);
  var dow=date.getDay();
  var monday=new Date(date.getTime()-(dow===0?6:dow-1)*864e5);
  monday=new Date(monday.getFullYear(),monday.getMonth(),monday.getDate());
  var days=[];
  for (var i=0;i<7;i++) { var d=new Date(monday.getTime()+i*864e5); days.push(formatDate(d)); }
  var now=new Date();
  var out={ weekStart:days[0], weekEnd:days[5], days:[], kpi:{ confirmedAmount:0, estimatedAmount:0, totalAppointments:0, npCount:0 }, doctorPerf:{}, clinicComp:{}, npList:[], npSource:{'波音轉介':0,'外部全新':0,'體系OP':0}, highFeeList:[] };

  days.forEach(function(ds){
    var dd=getDayData(ds);
    var dp=parseDate(ds); var isPast=(dp<=now); var isToday=formatDate(now)===ds;
    out.days.push({ date:ds, isPast:isPast, isToday:isToday, amount:dd.kpi.totalAmount, appointments:dd.kpi.totalAppointments, np:dd.kpi.npCount });
    if (isPast) out.kpi.confirmedAmount+=dd.kpi.totalAmount; else out.kpi.estimatedAmount+=dd.kpi.totalAmount;
    out.kpi.totalAppointments+=dd.kpi.totalAppointments;
    out.kpi.npCount+=dd.kpi.npCount;
    dd.doctorRanking.forEach(function(doc){
      if (!out.doctorPerf[doc.name]) out.doctorPerf[doc.name]={ name:doc.name, clinic:doc.clinic, color:doc.color, amount:0, sessions:0, shiftCount:0 };
      out.doctorPerf[doc.name].amount+=doc.amount; out.doctorPerf[doc.name].sessions+=doc.sessions; out.doctorPerf[doc.name].shiftCount+=(doc.shiftCount||1);
    });
    dd.clinics.forEach(function(c){
      if (!out.clinicComp[c.name]) out.clinicComp[c.name]={ name:c.name, color:c.color, total:0, amount:0 };
      out.clinicComp[c.name].total+=c.totalAppointments; out.clinicComp[c.name].amount+=c.totalAmount;
    });
    dd.npList.forEach(function(np){ out.npList.push(Object.assign({date:ds},np)); out.npSource[np.source]=(out.npSource[np.source]||0)+1; });
    dd.feeList.slice(0,5).forEach(function(f){ if(f.amount>=10000) out.highFeeList.push(Object.assign({date:ds,isPast:isPast},f)); });
  });

  out.kpi.estimatedAmount+=out.kpi.confirmedAmount;
  out.doctorPerfList=Object.values(out.doctorPerf).sort(function(a,b){return b.amount-a.amount;});
  out.clinicCompList=Object.values(out.clinicComp);
  out.highFeeList.sort(function(a,b){return b.amount-a.amount;});
  return out;
}

// ── 月資料 ───────────────────────────────────────────────────
function getMonthData(yearMonth) {
  var p=yearMonth.split('-'); var year=+p[0],month=+p[1];
  var first=new Date(year,month-1,1); var last=new Date(year,month,0);
  var now=new Date();
  var out={ yearMonth:yearMonth, kpi:{totalAppointments:0,totalAmount:0,npCount:0,avgDaily:0}, kpiPrev:{totalAppointments:0,totalAmount:0,npCount:0}, days:[], clinicTrend:{}, clinicMonthly:{}, doctorMonthly:{}, treatmentPie:{}, npList:[], npSource:{'波音轉介':0,'外部全新':0,'體系OP':0}, highFeeList:[] };
  CLINIC_NAMES.forEach(function(n){ out.clinicTrend[n]=[]; out.clinicMonthly[n]={name:n,color:CLINIC_COLORS[n],total:0,amount:0}; });

  // 上月KPI
  var prevFirst=new Date(year,month-2,1); var prevLast=new Date(year,month-1,0);
  for (var pd=new Date(prevFirst);pd<=prevLast;pd.setDate(pd.getDate()+1)) {
    try { var pq=getQuickKPI(formatDate(pd)); out.kpiPrev.totalAppointments+=pq.totalAppointments; out.kpiPrev.totalAmount+=pq.totalAmount; out.kpiPrev.npCount+=pq.npCount; } catch(e){}
  }

  var workDays=0;
  for (var d=new Date(first);d<=last;d.setDate(d.getDate()+1)) {
    var ds=formatDate(d);
    try {
      var dd=getDayData(ds);
      out.days.push({ date:ds, total:dd.kpi.totalAppointments, amount:dd.kpi.totalAmount });
      if (dd.kpi.totalAppointments>0) workDays++;
      out.kpi.totalAppointments+=dd.kpi.totalAppointments;
      out.kpi.totalAmount+=dd.kpi.totalAmount;
      out.kpi.npCount+=dd.kpi.npCount;
      dd.clinics.forEach(function(c){ out.clinicTrend[c.name].push(c.totalAppointments); out.clinicMonthly[c.name].total+=c.totalAppointments; out.clinicMonthly[c.name].amount+=c.totalAmount; });
      dd.doctorRanking.forEach(function(doc){
        if (!out.doctorMonthly[doc.name]) out.doctorMonthly[doc.name]={name:doc.name,clinic:doc.clinic,color:doc.color,amount:0,sessions:0,shiftCount:0};
        out.doctorMonthly[doc.name].amount+=doc.amount; out.doctorMonthly[doc.name].sessions+=doc.sessions; out.doctorMonthly[doc.name].shiftCount+=(doc.shiftCount||1);
      });
      Object.keys(dd.treatmentPie).forEach(function(k){ out.treatmentPie[k]=(out.treatmentPie[k]||0)+dd.treatmentPie[k]; });
      dd.npList.forEach(function(np){ out.npList.push(Object.assign({date:ds},np)); out.npSource[np.source]=(out.npSource[np.source]||0)+1; });
      dd.feeList.slice(0,3).forEach(function(f){ if(f.amount>=15000) out.highFeeList.push(Object.assign({date:ds},f)); });
    } catch(e){}
  }

  out.kpi.avgDaily=workDays>0?Math.round(out.kpi.totalAppointments/workDays):0;
  out.clinicMonthlyList=Object.values(out.clinicMonthly).sort(function(a,b){return b.total-a.total;});
  out.doctorMonthlyList=Object.values(out.doctorMonthly).sort(function(a,b){return b.amount-a.amount;});
  out.highFeeList.sort(function(a,b){return b.amount-a.amount;}); out.highFeeList=out.highFeeList.slice(0,10);
  return out;
}

// ── 月曆格資料 ───────────────────────────────────────────────
function getCalendarGridData(yearMonth) {
  var p=yearMonth.split('-'); var year=+p[0],month=+p[1];
  var first=new Date(year,month-1,1); var last=new Date(year,month,0);
  var result={};
  for (var d=new Date(first);d<=last;d.setDate(d.getDate()+1)) {
    var ds=formatDate(d);
    try {
      var dd=getDayData(ds);
      var dots=[];
      dd.clinics.forEach(function(c){ if(c.totalAppointments>0) dots.push(c.color); });
      result[ds]={ total:dd.kpi.totalAppointments, dots:dots };
    } catch(e){ result[ds]={ total:0, dots:[] }; }
  }
  return result;
}

// ── Client API ────────────────────────────────────────────────
function getTodayData() {
  try { return JSON.stringify(getDayData(formatDate(new Date()))); }
  catch(e) { return JSON.stringify({error:e.message}); }
}
function getDayDataForClient(dateStr) {
  try { return JSON.stringify(getDayData(dateStr)); }
  catch(e) { return JSON.stringify({error:e.message}); }
}
function getWeekDataForClient(dateStr) {
  try { return JSON.stringify(getWeekData(dateStr)); }
  catch(e) { return JSON.stringify({error:e.message}); }
}
function getMonthDataForClient(yearMonth) {
  try { return JSON.stringify(getMonthData(yearMonth)); }
  catch(e) { return JSON.stringify({error:e.message}); }
}
function getCalendarGridDataForClient(yearMonth) {
  try { return JSON.stringify(getCalendarGridData(yearMonth)); }
  catch(e) { return JSON.stringify({error:e.message}); }
}

// ── 診斷工具（GAS 編輯器執行用）────────────────────────────────
function testConfig() {
  var props = PropertiesService.getScriptProperties();
  var keyMap = { '林口':'CAL_LINKOU','忠孝':'CAL_ZHONGXIAO','巨蛋':'CAL_JUEDAN','頭等艙':'CAL_FIRST','波音':'CAL_BOEING' };
  console.log('=== Script Properties ===');
  CLINIC_NAMES.forEach(function(name) {
    var id = props.getProperty(keyMap[name]);
    console.log(name + ': ' + (id || '⚠️ 未設定'));
  });
  console.log('\n=== 可存取日曆列表 ===');
  try {
    var calendars = CalendarApp.getAllCalendars();
    console.log('共 ' + calendars.length + ' 個日曆');
    calendars.forEach(function(c) { console.log('  - ' + c.getName() + '\n    ID: ' + c.getId()); });
  } catch(e) { console.log('Error: ' + e.message); }
}

function testFetch() {
  var today = formatDate(new Date());
  console.log('=== 測試抓取: ' + today + ' ===');
  CLINIC_NAMES.forEach(function(name) {
    var id = getCalendarId(name);
    if (!id) { console.log(name + ': ⚠️ 無日曆 ID，跳過'); return; }
    var events = fetchClinicEvents(name, new Date());
    var valid = events.filter(function(ev) { return isValidAppointment(ev.title, ev.desc, ev.start); });
    console.log(name + ' (ID:'+id+'): 共 ' + events.length + ' 事件，有效 ' + valid.length);
    valid.slice(0, 3).forEach(function(ev) { console.log('  ' + ev.title + ' @ ' + formatTime(ev.start)); });
  });
}

// 一鍵寫入 Calendar ID 到 Script Properties
// 使用方式：先在試算表或 GAS 裡呼叫 saveCalendarIds({林口:'your-id@...',...})
function saveCalendarIds(idMap) {
  var props = PropertiesService.getScriptProperties();
  var keyMap = { '林口':'CAL_LINKOU','忠孝':'CAL_ZHONGXIAO','巨蛋':'CAL_JUEDAN','頭等艙':'CAL_FIRST','波音':'CAL_BOEING' };
  Object.keys(idMap).forEach(function(name) {
    if (keyMap[name]) { props.setProperty(keyMap[name], idMap[name]); console.log('已儲存 ' + name + ': ' + idMap[name]); }
  });
  _calCache = {}; // 清除記憶體快取
  console.log('完成。請重新載入儀表板。');
}
