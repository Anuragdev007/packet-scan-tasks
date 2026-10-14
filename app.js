import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
  query as fsQuery, orderBy, runTransaction, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------- roles (passwords live in Firebase Auth, never here) ---------- */
var MANAGERS=["manager1@packscan.local","manager2@packscan.local","manager3@packscan.local"];
var PACKERS=["packer1@packscan.local","packer2@packscan.local","packer3@packscan.local","packer4@packscan.local","packer5@packscan.local"];
function roleOf(email){email=String(email||"").toLowerCase();return MANAGERS.indexOf(email)>=0?"manager":PACKERS.indexOf(email)>=0?"packer":null}
var PART_SIZE=1500,MAX_IDS=60000;

var XLSX_URL="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
var PDF_URL="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
var PDFW_URL="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
var QR_URL="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";

function $(id){return document.getElementById(id)}
var me=null;                 /* {email, role} */
var fs=null,auth=null,tasksUnsub=null;
var tasks=[],tasksLoaded=false,mgrFilter="active",renaming=null,renameVal="",deleteArm=null,deleteT=0;
var cur=null;                /* the open task */
var filter="pending",query="",limit=300;
var jobs=[],opts={min:8,max:30,fmt:"any",prefix:""},draft={name:"",assign:""},creating=false;
var toastT=0,actx=null,scriptP={},sumT=0,finishArm=false,finishT=0;
var writeQ=Promise.resolve();
var cam={h:null,on:false,starting:false,lastCode:"",lastAt:0,torch:false,wake:null};
var coarse=!!(window.matchMedia&&window.matchMedia("(pointer:coarse)").matches);

/* ---------- helpers ---------- */
function norm(s){return String(s==null?"":s).toUpperCase().replace(/[^A-Z0-9]/g,"")}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function fmtTime(ts){return new Date(ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
function fmtFull(ts){return new Date(ts).toLocaleString()}
function fmtDay(ts){return ts?new Date(ts).toLocaleString([],{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):""}
function short(email){return email?String(email).split("@")[0]:""}
function colLetter(i){var s="";i++;while(i>0){var m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26)}return s}
function toast(msg){var t=$("toast");t.textContent=msg;t.hidden=false;clearTimeout(toastT);toastT=setTimeout(function(){t.hidden=true},2800)}
function clone(o){return o?JSON.parse(JSON.stringify(o)):{}}
function show(id,on){$(id).hidden=!on}
function findTask(tid){for(var i=0;i<tasks.length;i++){if(tasks[i].tid===tid)return tasks[i]}return null}
function D(path){return doc(fs,path)}

function setBanner(msg){$("banner").textContent=msg||"";$("banner").hidden=!msg}
function writeFailed(e){
  var code=e&&e.code;
  if(code==="permission-denied")toast("Not allowed: this account cannot make that change.");
  else if(code==="resource-exhausted")toast("Database limit reached for today. Try again later or upgrade the Firebase plan.");
  else toast("Could not save: "+((e&&e.message)||"connection problem")+". Check your connection.");
}
/* one write at a time, in order */
function queueWrite(fn){
  var p=writeQ.then(fn);
  writeQ=p.catch(function(e){writeFailed(e)});
  return p;
}

/* ---------- sign in ---------- */
$("loginForm").addEventListener("submit",function(e){
  e.preventDefault();
  var em=$("lgEmail").value.trim().toLowerCase(),pw=$("lgPass").value,err=$("lgErr"),b=$("lgBtn");
  if(!em||!pw){err.textContent="Enter your email and password.";err.hidden=false;return}
  if(!roleOf(em)){err.textContent="This email is not one of the team logins. Check the spelling.";err.hidden=false;return}
  err.hidden=true;b.disabled=true;b.textContent="Signing in…";
  signInWithEmailAndPassword(auth,em,pw).then(function(){$("lgPass").value=""},function(x){
    var c=x&&x.code;
    err.textContent=c==="auth/too-many-requests"?"Too many tries. Wait a few minutes, then try again.":
      c==="auth/network-request-failed"?"No internet connection. Check it and try again.":
      "That email and password do not match. Check both and try again.";
    err.hidden=false;
  }).then(function(){b.disabled=false;b.textContent="Sign in"});
});
$("logoutBtn").addEventListener("click",function(){
  leaveTask();closeImport();signOut(auth);
});

function route(){
  var signed=!!me;
  show("appTop",signed);show("loginView",!signed);
  if(signed){$("whoRole").textContent=me.role==="manager"?"Manager":"Packer";$("whoEmail").textContent=me.email}
  show("mgrView",signed&&me.role==="manager"&&!cur);
  show("packView",signed&&me.role==="packer"&&!cur);
  show("taskView",signed&&!!cur);
  if(signed&&!cur)renderBoards();
}

/* ---------- task boards ---------- */
function statusPill(t){
  if(t.status==="done")return'<span class="pill done">Done</span>';
  if(t.status==="accepted")return'<span class="pill prog">In progress</span>';
  return'<span class="pill open">Open</span>';
}
function progHtml(t){
  var total=t.total||0,sc=Math.min(t.scanned||0,total),pct=total?Math.floor(sc/total*100):0;
  return'<div class="t-prog"><div class="bar"><span style="width:'+pct+'%"></span></div><div class="nums">'+sc+' of '+total+' scanned'+(t.extra?' · '+t.extra+' not in list':'')+'</div></div>';
}
function metaLine(t){
  var bits=["By "+short(t.createdBy)+" · "+fmtDay(t.createdAt)];
  if(t.packer)bits.push("Packer: "+short(t.packer));
  else bits.push(t.assignedTo?"For "+short(t.assignedTo):"Any packer");
  if(t.status==="done"&&t.doneAt)bits.push("Finished "+fmtDay(t.doneAt));
  return bits.join(" · ");
}
function renameBox(t){
  return'<div class="rename"><input class="in" id="rn_'+esc(t.tid)+'" data-rn="'+esc(t.tid)+'" value="'+esc(renameVal)+'" aria-label="Task name" maxlength="120"><button class="btn mini" type="button" data-act="rnSave" data-tid="'+esc(t.tid)+'">Save</button><button class="btn mini" type="button" data-act="rnCancel">Cancel</button></div>';
}
function focusRename(){var ri=$("rn_"+renaming);if(ri){ri.focus();var n=ri.value.length;try{ri.setSelectionRange(n,n)}catch(e){}}}
function nameBlock(t,canRename){
  if(renaming===t.tid)return renameBox(t);
  return'<div class="t-name"><strong>'+esc(t.name)+'</strong>'+(canRename?'<button class="btn mini" type="button" data-act="rename" data-tid="'+esc(t.tid)+'">Rename</button>':'')+'</div>';
}
function taskRow(t,actions,canRename){
  return'<li class="task"><div class="t-main">'+nameBlock(t,canRename)+'<div class="t-meta">'+esc(metaLine(t))+'</div></div>'+statusPill(t)+progHtml(t)+'<div class="t-act">'+actions+'</div></li>';
}
function btn(act,tid,label,cls){return'<button class="btn mini'+(cls?" "+cls:"")+'" type="button" data-act="'+act+'" data-tid="'+esc(tid)+'">'+label+'</button>'}
function emptyRow(msg){return'<li class="empty">'+esc(msg)+'</li>'}

function renderBoards(){
  if(!me)return;
  var loading=!tasksLoaded;
  if(me.role==="manager"){
    var c={active:0,open:0,accepted:0,done:0,all:tasks.length};
    tasks.forEach(function(t){c[t.status]=(c[t.status]||0)+1;if(t.status!=="done")c.active++});
    $("mcActive").textContent=c.active;$("mcOpen").textContent=c.open;$("mcProg").textContent=c.accepted;$("mcDone").textContent=c.done;$("mcAll").textContent=c.all;
    Array.prototype.forEach.call($("mgrChips").children,function(b){b.setAttribute("aria-pressed",b.getAttribute("data-f")===mgrFilter?"true":"false")});
    var list=tasks.filter(function(t){return mgrFilter==="all"||(mgrFilter==="active"?t.status!=="done":t.status===mgrFilter)});
    var h=list.map(function(t){
      var a=btn("view",t.tid,"View");
      if(t.status==="done")a+=btn("reopen",t.tid,"Reopen");
      a+=btn("delete",t.tid,deleteArm===t.tid?"Click again to delete":"Delete",deleteArm===t.tid?"warn":"");
      return taskRow(t,a,true);
    }).join("");
    $("mgrTasks").innerHTML=h||emptyRow(loading?"Loading tasks…":tasks.length?"No tasks in this view.":"No tasks yet. Use New task from Excel / PDF to create the first one.");
    if(renaming)focusRename();
  }else{
    var mine=[],open=[],done=[];
    tasks.forEach(function(t){
      if(t.status==="accepted"&&t.packer===me.email)mine.push(t);
      else if(t.status==="open"&&(!t.assignedTo||t.assignedTo===me.email))open.push(t);
      else if(t.status==="done"&&t.packer===me.email)done.push(t);
    });
    done=done.slice(0,20);
    $("pcMine").textContent=mine.length;$("pcOpen").textContent=open.length;$("pcDone").textContent=done.length;
    $("packMine").innerHTML=mine.map(function(t){return taskRow(t,btn("view",t.tid,"Continue scanning"),false)}).join("")||emptyRow(loading?"Loading tasks…":"You have no task in progress. Accept one below.");
    $("packOpen").innerHTML=open.map(function(t){return taskRow(t,btn("accept",t.tid,"Accept task"),false)}).join("")||emptyRow(loading?"Loading tasks…":"No tasks are waiting. New tasks from your manager appear here.");
    $("packDone").innerHTML=done.map(function(t){return taskRow(t,btn("view",t.tid,"View"),false)}).join("")||emptyRow(loading?"Loading tasks…":"Tasks you finish appear here.");
  }
}
function boardClick(e){
  var b=e.target.closest("button[data-act]");if(!b)return;
  var act=b.getAttribute("data-act"),tid=b.getAttribute("data-tid");
  if(act==="view")openTask(tid);
  else if(act==="accept")acceptTask(tid,b);
  else if(act==="rename"){var rt=findTask(tid);renaming=tid;renameVal=rt?rt.name:"";cur?renderTaskHead():renderBoards()}
  else if(act==="rnCancel"){renaming=null;cur?renderTaskHead():renderBoards()}
  else if(act==="rnSave")saveRename(tid);
  else if(act==="reopen")reopenTask(tid);
  else if(act==="delete")deleteTask(tid);
}
function renameKey(e){
  var i=e.target.closest("input[data-rn]");if(!i)return;
  if(e.key==="Enter"){e.preventDefault();saveRename(i.getAttribute("data-rn"))}
  else if(e.key==="Escape"){renaming=null;cur?renderTaskHead():renderBoards()}
}
["mgrTasks","packMine","packOpen","packDone","tvNameRow"].forEach(function(id){
  $(id).addEventListener("click",boardClick);$(id).addEventListener("keydown",renameKey);
  $(id).addEventListener("input",function(e){if(e.target.hasAttribute("data-rn"))renameVal=e.target.value});
});
$("mgrChips").addEventListener("click",function(e){var b=e.target.closest("button[data-f]");if(!b)return;mgrFilter=b.getAttribute("data-f");renderBoards()});

function saveRename(tid){
  var i=$("rn_"+tid);if(!i)return;
  var name=i.value.trim(),t=findTask(tid);
  if(!name){toast("Task name cannot be empty");i.focus();return}
  renaming=null;
  if(t&&t.name!==name){
    queueWrite(function(){return updateDoc(D("tasks/"+tid),{name:name,updatedAt:Date.now()})}).then(function(){toast("Task renamed")},function(){});
  }
  cur?renderTaskHead():renderBoards();
}
function reopenTask(tid){
  var t=findTask(tid);if(!t)return;
  queueWrite(function(){return updateDoc(D("tasks/"+tid),{status:t.packer?"accepted":"open",doneAt:null,updatedAt:Date.now()})}).then(function(){toast(t.packer?"Reopened for "+short(t.packer):"Task reopened")},function(){});
}
function deleteTask(tid){
  var t=findTask(tid);if(!t)return;
  if(deleteArm!==tid){deleteArm=tid;clearTimeout(deleteT);deleteT=setTimeout(function(){deleteArm=null;renderBoards()},4000);renderBoards();return}
  deleteArm=null;clearTimeout(deleteT);
  var parts=t.parts||1;
  queueWrite(function(){
    var b=writeBatch(fs);
    b.delete(D("tasks/"+tid));
    b.delete(D("tasks/"+tid+"/progress/extras"));
    for(var i=0;i<parts;i++){b.delete(D("tasks/"+tid+"/parts/p"+i));b.delete(D("tasks/"+tid+"/progress/p"+i))}
    return b.commit();
  }).then(function(){toast("Deleted "+t.name)},function(){});
}
function acceptTask(tid,b){
  b.disabled=true;b.textContent="Accepting…";
  var ref=D("tasks/"+tid),msg="";
  /* a transaction, so two packers cannot take the same task */
  runTransaction(fs,function(tx){
    return tx.get(ref).then(function(s){
      if(!s.exists()){msg="This task was deleted.";return}
      var t=s.data();
      if(t.status!=="open"||(t.packer&&t.packer!==me.email)){msg="Already taken by "+short(t.packer||"another packer")+".";return}
      if(t.assignedTo&&t.assignedTo!==me.email){msg="This task is for "+short(t.assignedTo)+".";return}
      tx.update(ref,{status:"accepted",packer:me.email,acceptedAt:Date.now(),updatedAt:Date.now()});
    });
  }).then(function(){
    if(msg){toast(msg);renderBoards();return}
    toast("Task accepted");openTask(tid);
  },function(e){writeFailed(e);renderBoards()});
}

/* ---------- tasks subscription ---------- */
function subscribeTasks(){
  if(tasksUnsub)tasksUnsub();
  tasksUnsub=onSnapshot(fsQuery(collection(fs,"tasks"),orderBy("createdAt","desc")),function(s){
    tasks=s.docs.map(function(d){var o=d.data();o.tid=d.id;return o});
    tasksLoaded=true;
    if(cur){
      var t=findTask(cur.tid);
      if(!t){leaveTask();toast("This task was deleted by a manager.");route();return}
      cur.task=t;renderTaskHead();renderTask();
    }else renderBoards();
  },function(e){
    tasksLoaded=true;
    setBanner(e&&e.code==="permission-denied"?"This account is not allowed to read tasks. Check the Firestore rules (see the README).":"Lost connection to the task list. Reload the page.");
    renderBoards();
  });
}

/* ---------- open one task ---------- */
function isReadOnly(){return !cur||me.role!=="packer"||cur.task.status!=="accepted"||cur.task.packer!==me.email}
function openTask(tid){
  var t=findTask(tid);if(!t)return;
  leaveTask();closeImport();
  cur={tid:tid,task:t,list:[],parts:[],idx:new Map(),extras:{},loaded:false,undo:[],unsubs:[]};
  filter=me.role==="packer"?"pending":"all";query="";$("q").value="";limit=300;finishArm=false;
  route();window.scrollTo(0,0);
  renderTaskHead();renderTask();
  showResult("idle","Loading","","Getting the tracking IDs for this task…");
  var n=t.parts||1,gets=[];
  for(var i=0;i<n;i++)gets.push(getDoc(D("tasks/"+tid+"/parts/p"+i)));
  var mine=cur;
  Promise.all(gets).then(function(snaps){
    if(cur!==mine)return;
    snaps.forEach(function(s,p){
      var raw=(s.exists()&&s.data().items)||[];
      var items=raw.map(function(a){return{id:a.i,key:norm(a.i),src:a.s||"",p:p,s:null}});
      cur.parts[p]=items;
      items.forEach(function(it){cur.list.push(it);cur.idx.set(it.key,it)});
    });
    cur.loaded=true;
    for(var p=0;p<n;p++)(function(p){
      cur.unsubs.push(onSnapshot(D("tasks/"+tid+"/progress/p"+p),function(s){
        if(cur!==mine)return;
        var sc=(s.exists()&&s.data().scans)||{};
        (cur.parts[p]||[]).forEach(function(it){var v=sc[it.key];it.s=v?[v.at,v.m?1:0]:null});
        renderTask();
      },function(){}));
    })(p);
    cur.unsubs.push(onSnapshot(D("tasks/"+tid+"/progress/extras"),function(s){
      if(cur!==mine)return;
      cur.extras=clone((s.exists()&&s.data().extras)||{});
      renderTask();
    },function(){}));
    renderTask();
    if(isReadOnly())showResult("idle",me.role==="manager"?"Live view":"View only","",me.role==="manager"?"Scans by the packer appear here as they happen.":"This task is finished.");
    else showResult("idle","Ready","","Scan a packet to check it against the list.");
    if(!isReadOnly()&&!coarse){try{$("scanInput").focus({preventScroll:true})}catch(e){}}
  }).catch(function(e){if(cur===mine)showResult("bad","Could not load","",(e&&e.message)||"Check your connection and open the task again.")});
}
function leaveTask(){
  if(!cur)return;
  if(cam.on||cam.starting)stopCamera();
  if(sumT){clearTimeout(sumT);pushSummary()}
  cur.unsubs.forEach(function(u){try{u()}catch(e){}});
  cur=null;renaming=null;
}
$("backBtn").addEventListener("click",function(){leaveTask();route();window.scrollTo(0,0)});

function renderTaskHead(){
  if(!cur)return;
  var t=cur.task,ro=isReadOnly(),row=$("tvNameRow");
  if(renaming===t.tid){row.innerHTML=renameBox(t);focusRename()}
  else row.innerHTML='<h1>'+esc(t.name)+'</h1>'+statusPill(t)+(me.role==="manager"?'<button class="btn mini" type="button" data-act="rename" data-tid="'+esc(t.tid)+'">Rename</button>':'');
  $("tvMeta").textContent=metaLine(t);
  show("desk",!ro);
  $("finishBtn").hidden=ro;
  if(!finishArm)$("finishBtn").textContent="Finish task";
  if(ro&&(cam.on||cam.starting))stopCamera();
}

/* ---------- scan result + sound ---------- */
function showResult(kind,word,id,det){
  var r=$("result");r.className="result "+kind;
  r.innerHTML='<div class="word">'+esc(word)+'</div>'+(id?'<div class="rid">'+esc(id)+'</div>':'')+(det?'<div class="det">'+esc(det)+'</div>':'');
}
function audioCtx(){
  try{
    actx=actx||new(window.AudioContext||window.webkitAudioContext)();
    if(actx.state==="suspended")actx.resume();
    return actx;
  }catch(e){return null}
}
function buzz(freqs,start,dur,type,vol){
  freqs.forEach(function(f){
    var o=actx.createOscillator(),g=actx.createGain();
    o.type=type;o.frequency.value=f;
    g.gain.setValueAtTime(.0001,start);
    g.gain.linearRampToValueAtTime(vol,start+.005);
    g.gain.setValueAtTime(vol,start+dur-.02);
    g.gain.linearRampToValueAtTime(.0001,start+dur);
    o.connect(g);g.connect(actx.destination);o.start(start);o.stop(start+dur+.02);
  });
}
function beep(kind){
  if(!$("sound").checked)return;
  var c=audioCtx();if(!c)return;
  var t=c.currentTime+.01;
  if(kind==="ok"){
    /* good scan: two short, loud, high buzzes */
    buzz([1000],t,.16,"square",.9);
    buzz([1500],t+.2,.22,"square",.9);
  }else{
    /* wrong or repeated scan: three long, loud, low alarm pulses */
    [0,.33,.66].forEach(function(off){buzz([160,167],t+off,.25,"square",.5)});
  }
}
['pointerdown','keydown','touchstart'].forEach(function(ev){document.addEventListener(ev,function(){audioCtx()},{once:true,passive:true})});

var camFlashT=0;
function flashCam(kind){
  var f=$("camFrame");if(!f||!cam.on)return;
  f.className="camframe "+(kind==="ok"?"good":"bad");
  clearTimeout(camFlashT);
  camFlashT=setTimeout(function(){f.className="camframe"},kind==="ok"?900:1600);
}

/* ---------- scanning ---------- */
function counts(){
  var s=0,e=0,k;
  if(cur){for(var i=0;i<cur.list.length;i++){if(cur.list[i].s)s++}for(k in cur.extras){if(cur.extras[k])e++}}
  var total=cur?cur.list.length:0;
  return{total:total,scanned:s,pending:total-s,extra:e};
}
function extrasList(){
  var out=[];for(var k in cur.extras){var x=cur.extras[k];if(x)out.push({id:x.id,key:k,at:x.at,count:x.count})}
  return out.sort(function(a,b){return b.at-a.at});
}
function writeScan(it,val){
  var tid=cur.tid,patch={scans:{}};patch.scans[it.key]=val?{at:val[0],m:val[1]}:null;
  queueWrite(function(){return setDoc(D("tasks/"+tid+"/progress/p"+it.p),patch,{merge:true})}).catch(function(){});
  scheduleSummary();
}
function writeExtra(key,val){
  var tid=cur.tid,patch={extras:{}};patch.extras[key]=val;
  queueWrite(function(){return setDoc(D("tasks/"+tid+"/progress/extras"),patch,{merge:true})}).catch(function(){});
  scheduleSummary();
}
function scheduleSummary(){clearTimeout(sumT);sumT=setTimeout(pushSummary,1200)}
function pushSummary(){
  sumT=0;if(!cur)return;
  var c=counts(),tid=cur.tid;
  queueWrite(function(){return updateDoc(D("tasks/"+tid),{scanned:c.scanned,extra:c.extra,updatedAt:Date.now()})}).catch(function(){});
}
function pushUndo(o){cur.undo.push(o);if(cur.undo.length>200)cur.undo.shift()}

function handleScan(raw){
  var code=String(raw||"").trim();
  if(!code||!cur)return;
  if(isReadOnly()){showResult("bad","View only",code,"This task is not open for scanning on your account.");beep("bad");return}
  if(!cur.loaded){showResult("bad","Still loading",code,"Wait a moment for the list to load, then scan again.");beep("bad");return}
  var key=norm(code);
  if(!key){showResult("bad","Unreadable",code,"That scan has no letters or digits.");beep("bad");flashCam("bad");return}
  var it=cur.idx.get(key),ts=Date.now();
  if(!it&&/[^A-Za-z0-9]/.test(code)){
    /* QR codes and some labels hold a link or extra text: look for a listed ID inside it */
    var toks=code.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g)||[],hit=null,hits=0;
    for(var k=0;k<toks.length;k++){var h2=cur.idx.get(norm(toks[k]));if(h2&&h2!==hit){hit=h2;hits++}}
    if(hits===1)it=hit;
  }
  if(it){
    if(it.s){
      showResult("dup","Already scanned",it.id,"First scanned at "+fmtTime(it.s[0])+(it.s[1]?" (marked by hand).":"."));beep("dup");flashCam("dup");
    }else{
      it.s=[ts,0];pushUndo({op:"scan",it:it});writeScan(it,[ts,0]);
      var c=counts();
      showResult("ok","Scanned",it.id,c.pending?c.scanned+" of "+c.total+" done · "+c.pending+" left":"All "+c.total+" packets scanned. Task completed.");beep("ok");flashCam("ok");
      autoFinishIfComplete();
    }
  }else{
    var prev=cur.extras[key]||null;
    var ex=prev?{id:prev.id,at:prev.at,count:(prev.count||1)+1}:{id:code,at:ts,count:1};
    cur.extras[key]=ex;pushUndo({op:"extra",key:key,prev:prev?clone(prev):null});writeExtra(key,ex);
    showResult("bad","Not in list",code,ex.count>1?"Scanned "+ex.count+" times. Set this packet aside.":"Set this packet aside and check its tracking ID.");beep("bad");flashCam("bad");
  }
  renderTask();
}
function toggleManual(key){
  if(isReadOnly())return;
  var it=cur.idx.get(key);if(!it)return;
  if(it.s){pushUndo({op:"unscan",it:it,prev:it.s});it.s=null;writeScan(it,null);showResult("idle","Unmarked",it.id,"Back on the not-scanned list.")}
  else{it.s=[Date.now(),1];pushUndo({op:"scan",it:it});writeScan(it,it.s);showResult("idle","Marked by hand",it.id,"Counted as scanned.");autoFinishIfComplete()}
  renderTask();
}
function doUndo(){
  if(!cur||isReadOnly())return;
  var u=cur.undo.pop();
  if(!u){toast("Nothing to undo");return}
  if(u.op==="scan"){u.it.s=null;writeScan(u.it,null);showResult("idle","Undone",u.it.id,"Back on the not-scanned list.")}
  else if(u.op==="unscan"){u.it.s=u.prev;writeScan(u.it,u.prev);showResult("idle","Undone",u.it.id,"Marked as scanned again.")}
  else if(u.op==="extra"){var id=(cur.extras[u.key]||u.prev||{}).id||u.key;cur.extras[u.key]=u.prev;writeExtra(u.key,u.prev);showResult("idle","Undone",id,"Removed that scan.")}
  renderTask();
}

/* ---------- task rendering ---------- */
function visibleRows(){
  var q=norm(query),out;
  if(filter==="extras")out=extrasList();
  else if(filter==="pending")out=cur.list.filter(function(it){return!it.s});
  else if(filter==="scanned")out=cur.list.filter(function(it){return it.s}).sort(function(a,b){return b.s[0]-a.s[0]});
  else out=cur.list.slice();
  if(q)out=out.filter(function(it){return it.key.indexOf(q)>=0});
  return out;
}
function rowHtml(it,ro){
  if(filter==="extras"){
    return'<li class="row"><span class="pill bad">Not in list</span><span class="rid">'+esc(it.id)+'</span><span class="rmeta">'+(it.count>1?"Scanned "+it.count+" times · ":"")+esc(fmtTime(it.at))+'</span><span class="act"></span></li>';
  }
  var sc=!!it.s,meta=esc(it.src||"");
  if(sc)meta+=(meta?" · ":"")+esc(fmtTime(it.s[0]))+(it.s[1]?" (by hand)":"");
  var act=ro?"":'<button class="btn mini" type="button" data-act="toggle" data-key="'+esc(it.key)+'">'+(sc?"Unmark":"Mark scanned")+'</button>';
  return'<li class="row"><span class="pill '+(sc?"ok":"pending")+'">'+(sc?"Scanned":"Not scanned")+'</span><span class="rid">'+esc(it.id)+'</span><span class="rmeta">'+meta+'</span><span class="act">'+act+'</span></li>';
}
function renderTask(){
  if(!cur)return;
  var c=counts(),ro=isReadOnly();
  $("nTotal").textContent=c.total;$("nScanned").textContent=c.scanned;$("nPending").textContent=c.pending;$("nExtra").textContent=c.extra;
  var pct=c.total?Math.floor(c.scanned/c.total*100):0;
  $("barFill").style.width=pct+"%";$("pct").textContent=pct+"%";
  $("cPending").textContent=c.pending;$("cScanned").textContent=c.scanned;$("cExtra").textContent=c.extra;$("cAll").textContent=c.total;
  Array.prototype.forEach.call($("chips").children,function(b){b.setAttribute("aria-pressed",b.getAttribute("data-f")===filter?"true":"false")});
  var rows=cur.loaded?visibleRows():[],shown=rows.slice(0,limit),h=[];
  for(var i=0;i<shown.length;i++)h.push(rowHtml(shown[i],ro));
  $("rows").innerHTML=h.join("");
  var e=$("empty"),msg="",good=false;
  if(!cur.loaded)msg="Loading tracking IDs…";
  else if(!rows.length){
    if(query.trim())msg="No tracking ID matches that search.";
    else if(filter==="pending"){msg="Every packet on the list has been scanned.";good=true}
    else if(filter==="scanned")msg="Nothing scanned yet.";
    else if(filter==="extras")msg="No packets scanned that are missing from the list.";
    else msg="This task has no tracking IDs.";
  }
  e.hidden=!msg;e.textContent=msg;e.className="empty"+(good?" good":"");
  var more=$("moreBtn");more.hidden=rows.length<=limit;
  if(!more.hidden)more.textContent="Show "+Math.min(300,rows.length-limit)+" more ("+(rows.length-limit)+" hidden)";
}
function setReady(on){var r=$("ready");r.className="ready "+(on?"on":"off");r.textContent=on?"Scanner ready. Scan a packet now.":"Click the box above before scanning."}

$("finishBtn").addEventListener("click",function(){
  if(!cur||isReadOnly())return;
  var b=this,c=counts();
  if(c.pending>0&&!finishArm){
    finishArm=true;b.textContent=c.pending+" not scanned. Click again to finish anyway";b.classList.add("warn");
    clearTimeout(finishT);finishT=setTimeout(function(){finishArm=false;b.textContent="Finish task";b.classList.remove("warn")},4000);
    return;
  }
  finishArm=false;clearTimeout(finishT);b.classList.remove("warn");b.textContent="Finish task";
  finishTask(false);
});
/* auto: every packet is scanned, so finish and stay on the task, which turns read-only */
function finishTask(auto){
  if(!cur||isReadOnly()||cur.finishing)return;
  cur.finishing=true;
  var c=counts(),tid=cur.tid;
  clearTimeout(sumT);sumT=0;
  queueWrite(function(){return updateDoc(D("tasks/"+tid),{status:"done",doneAt:Date.now(),scanned:c.scanned,extra:c.extra,updatedAt:Date.now()})}).then(function(){
    if(auto){toast("All packets scanned. Task moved to Completed.");return}
    toast("Task finished");leaveTask();route();window.scrollTo(0,0);
  },function(){if(cur&&cur.tid===tid)cur.finishing=false});
}
function autoFinishIfComplete(){
  var c=counts();
  if(c.total>0&&c.pending===0)finishTask(true);
}

/* ---------- libraries (loaded only when needed) ---------- */
function loadScript(src){
  if(scriptP[src])return scriptP[src];
  scriptP[src]=new Promise(function(res,rej){
    var s=document.createElement("script");s.src=src;s.onload=res;
    s.onerror=function(){delete scriptP[src];rej(new Error("Could not load "+src.split("/").pop()+". Check your internet connection."))};
    document.head.appendChild(s);
  });
  return scriptP[src];
}
function needXlsx(){return window.XLSX?Promise.resolve():loadScript(XLSX_URL)}
function needPdf(){
  return loadScript(PDF_URL).then(function(){
    window.pdfjsLib.GlobalWorkerOptions.workerSrc=PDFW_URL;
  });
}

/* ---------- reading files ---------- */
function cellStr(v){
  if(v==null||v==="")return"";
  if(typeof v==="number")return String(v);
  return String(v).trim();
}
function idLike(s){return/^(?=.*\d)[A-Za-z0-9][A-Za-z0-9\-]{5,40}$/.test(s)}
var HEAD_RE=/track|awb|waybill|way bill|consign|docket|barcode|shipment|parcel|packet|article|\blr\b|\bcn\b|reference/i;

function readSheet(f){
  return needXlsx().then(function(){return f.arrayBuffer()}).then(function(buf){
    var wb=XLSX.read(buf,{type:"array",raw:true});
    var cols=[],cells=[],multi=wb.SheetNames.length>1;
    wb.SheetNames.forEach(function(sn){
      var ws=wb.Sheets[sn];if(!ws||!ws["!ref"])return;
      var r0=XLSX.utils.decode_range(ws["!ref"]).s.r;
      var rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:"",blankrows:true});
      var first=-1,i,c;
      for(i=0;i<rows.length&&first<0;i++){for(c=0;c<rows[i].length;c++){if(cellStr(rows[i][c])!==""){first=i;break}}}
      if(first<0)return;
      var hdr=rows[first],isHdr=true,nonEmpty=0;
      for(c=0;c<hdr.length;c++){var hv=hdr[c];if(cellStr(hv)==="")continue;nonEmpty++;if(typeof hv!=="string"||idLike(hv.trim())){isHdr=false;break}}
      if(!nonEmpty)isHdr=false;
      var start=isHdr?first+1:first,width=0;
      rows.forEach(function(r){if(r.length>width)width=r.length});
      for(c=0;c<width;c++){
        var vals=[],like=0;
        for(i=start;i<rows.length;i++){
          var s=cellStr(rows[i][c]);if(!s)continue;
          vals.push({v:s,r:i+r0+1});if(idLike(s))like++;
        }
        if(!vals.length)continue;
        var label=isHdr&&cellStr(hdr[c])?cellStr(hdr[c]):"Column "+colLetter(c);
        cols.push({sheet:sn,multi:multi,label:label,values:vals,hs:HEAD_RE.test(label)?1:0,ratio:like/vals.length});
      }
      for(i=first;i<rows.length;i++){for(c=0;c<rows[i].length;c++){var t=cellStr(rows[i][c]);if(t)cells.push({v:t,sn:sn,r:i+r0+1})}}
    });
    if(!cols.length)return{name:f.name,kind:"bad",error:"No data found in this file."};
    var best=-1,bs=-1;
    cols.forEach(function(col,k){var sc=col.hs*2+col.ratio;if(sc>bs){bs=sc;best=k}});
    var choice=(cols[best].hs||cols[best].ratio>=.5)?String(best):"all";
    return{name:f.name,kind:"sheet",cols:cols,cells:cells,choice:choice};
  });
}
function readPdf(f,onPage){
  return needPdf().then(function(){return f.arrayBuffer()}).then(function(buf){
    return window.pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise;
  }).then(function(pdf){
    var pages=[],n=pdf.numPages;
    function next(p){
      if(p>n)return Promise.resolve();
      return pdf.getPage(p).then(function(pg){return pg.getTextContent()}).then(function(tc){
        pages.push(tc.items.map(function(i){return i.str+(i.hasEOL?"\n":" ")}).join(""));
        if(onPage)onPage(p,n);
        return next(p+1);
      });
    }
    return next(1).then(function(){
      var all=pages.join("").replace(/\s/g,"");
      return{name:f.name,kind:"pdf",pages:pages,noText:all.length<20};
    });
  });
}
function handleFiles(fileList){
  if(!me||me.role!=="manager"||cur)return;
  var files=Array.prototype.slice.call(fileList||[]);
  if(!files.length)return;
  var p=$("importPanel");p.hidden=false;p.innerHTML='<h2>Reading files</h2><p class="note" id="busy">Opening '+files.length+' file'+(files.length>1?"s":"")+'…</p>';
  jobs=[];
  draft.name=files[0].name.replace(/\.[^.]+$/,"")+" · "+new Date().toLocaleDateString([],{day:"numeric",month:"short"});
  var chain=Promise.resolve();
  files.forEach(function(f){
    chain=chain.then(function(){
      var ext=(f.name.split(".").pop()||"").toLowerCase(),job;
      if(ext==="pdf"||f.type==="application/pdf"){
        job=readPdf(f,function(pg,n){var b=$("busy");if(b)b.textContent="Reading "+f.name+": page "+pg+" of "+n+"…"});
      }else if(["xlsx","xls","xlsm","csv","tsv","ods"].indexOf(ext)>=0){
        job=readSheet(f);
      }else{
        job=Promise.resolve({name:f.name,kind:"bad",error:"Unsupported file type. Use .xlsx, .xls, .csv or .pdf."});
      }
      return job.then(function(j){jobs.push(j)},function(e){jobs.push({name:f.name,kind:"bad",error:"Could not read this file: "+(e&&e.message?e.message:e)})});
    });
  });
  chain.then(function(){renderImport()});
}

/* ---------- extracting IDs ---------- */
function prefixList(){return opts.prefix.split(/[,\s]+/).map(norm).filter(Boolean)}
function extractJob(j){
  var out=[];
  if(j.kind==="bad")return out;
  var pre=prefixList();
  function accept(key){if(!pre.length)return true;for(var i=0;i<pre.length;i++){if(key.indexOf(pre[i])===0)return true}return false}
  if(j.kind==="sheet"&&j.choice!=="all"){
    var col=j.cols[+j.choice];if(!col)return out;
    col.values.forEach(function(v){var key=norm(v.v);if(key&&accept(key))out.push({id:v.v,key:key,src:j.name+" · "+(col.multi?col.sheet+" · ":"")+"row "+v.r})});
    return out;
  }
  var chunks=[];
  if(j.kind==="pdf")j.pages.forEach(function(t,i){chunks.push({t:t,src:j.name+" · page "+(i+1)})});
  else j.cells.forEach(function(c){chunks.push({t:c.v,src:j.name+" · "+c.sn+" · row "+c.r})});
  var min=Math.max(1,+opts.min||1),max=Math.max(min,+opts.max||60);
  chunks.forEach(function(ch){
    var m=ch.t.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g)||[];
    m.forEach(function(t){
      var key=norm(t),L=key.length;
      if(L<min||L>max||!/\d/.test(key))return;
      if(opts.fmt==="digits"&&!/^\d+$/.test(key))return;
      if(/^\d{1,4}-\d{1,2}-\d{1,4}$/.test(t))return;
      if(!accept(key))return;
      out.push({id:t,key:key,src:ch.src});
    });
  });
  return out;
}
function computeImport(){
  var seen=new Set(),items=[],dups=0;
  jobs.forEach(function(j){
    extractJob(j).forEach(function(it){
      if(seen.has(it.key)){dups++;return}
      seen.add(it.key);items.push(it);
    });
  });
  return{items:items,dups:dups};
}

/* ---------- new task panel ---------- */
function renderImport(){
  var p=$("importPanel"),h='<h2>New task</h2>';
  h+='<div class="taskset"><div><label class="fl" for="tkName">Task name</label><input class="in" id="tkName" type="text" maxlength="120" value="'+esc(draft.name)+'"></div>'+
     '<div><label class="fl" for="tkAssign">Who can accept it</label><select class="in" id="tkAssign"><option value="">Any packer</option>'+
     PACKERS.map(function(e){return'<option value="'+esc(e)+'"'+(draft.assign===e?" selected":"")+'>Only '+esc(short(e))+'</option>'}).join("")+'</select></div></div>';
  jobs.forEach(function(j,i){
    h+='<div class="job"><div class="jh"><strong>'+esc(j.name)+'</strong><span class="tag">'+(j.kind==="pdf"?"PDF":j.kind==="sheet"?"Spreadsheet":"Problem")+'</span></div>';
    if(j.kind==="bad"){h+='<p class="err">'+esc(j.error)+'</p>'}
    else if(j.kind==="pdf"){
      h+='<p class="note">'+j.pages.length+' page'+(j.pages.length===1?"":"s")+' read. ';
      h+=j.noText?'No selectable text found. This looks like a scanned image and text recognition (OCR) is not included. Export the list from the source system as Excel, or as a PDF with real text.':'Tracking IDs are picked out of the text using the filters below.';
      h+='</p>';
    }else{
      h+='<label class="fl" for="col'+i+'">Column with tracking IDs</label><select class="in" id="col'+i+'" data-job="'+i+'">';
      j.cols.forEach(function(c,k){h+='<option value="'+k+'"'+(String(k)===j.choice?" selected":"")+'>'+esc((c.multi?c.sheet+" › ":"")+c.label)+' ('+c.values.length+' values)</option>'});
      h+='<option value="all"'+(j.choice==="all"?" selected":"")+'>Search every cell in this file</option></select>';
    }
    h+='</div>';
  });
  h+='<div class="filters">'+
    '<div><label class="fl" for="fMin">Min length</label><input class="in" id="fMin" type="number" min="1" max="60" value="'+esc(opts.min)+'"></div>'+
    '<div><label class="fl" for="fMax">Max length</label><input class="in" id="fMax" type="number" min="1" max="60" value="'+esc(opts.max)+'"></div>'+
    '<div><label class="fl" for="fFmt">Format</label><select class="in" id="fFmt"><option value="any"'+(opts.fmt==="any"?" selected":"")+'>Letters and digits</option><option value="digits"'+(opts.fmt==="digits"?" selected":"")+'>Digits only</option></select></div>'+
    '<div><label class="fl" for="fPre">Starts with (optional)</label><input class="in" id="fPre" type="text" placeholder="e.g. EE, TBA" value="'+esc(opts.prefix)+'"></div>'+
  '</div>';
  h+='<p class="note">Length and format apply to PDF text and "every cell" searches. "Starts with" applies to everything. Phone numbers and invoice numbers in a PDF can look like tracking IDs, so check the preview.</p>';
  h+='<div><div class="sum" id="isum"></div><div class="sample" id="isample"></div></div>';
  h+='<div class="ibtns"><button class="btn primary" id="iOk" type="button">Create task</button><button class="btn" id="iCancel" type="button">Cancel</button></div>';
  p.innerHTML=h;p.hidden=false;
  Array.prototype.forEach.call(p.querySelectorAll("select[data-job]"),function(s){s.addEventListener("change",function(){jobs[+s.getAttribute("data-job")].choice=s.value;updateImportSummary()})});
  $("tkName").addEventListener("input",function(){draft.name=this.value});
  $("tkAssign").addEventListener("change",function(){draft.assign=this.value});
  $("fMin").addEventListener("input",function(){opts.min=this.value;updateImportSummary()});
  $("fMax").addEventListener("input",function(){opts.max=this.value;updateImportSummary()});
  $("fFmt").addEventListener("change",function(){opts.fmt=this.value;updateImportSummary()});
  $("fPre").addEventListener("input",function(){opts.prefix=this.value;updateImportSummary()});
  $("iOk").addEventListener("click",createTask);
  $("iCancel").addEventListener("click",closeImport);
  updateImportSummary();
  p.scrollIntoView({block:"nearest"});
}
function updateImportSummary(){
  var r=computeImport(),n=r.items.length;
  $("isum").textContent=n?n+" unique tracking ID"+(n===1?"":"s")+" found"+(r.dups?" · "+r.dups+" repeat"+(r.dups===1?"":"s")+" removed":"")+(n>MAX_IDS?" · too many for one task (limit "+MAX_IDS+")":""):"No tracking IDs found with these settings.";
  $("isample").innerHTML=r.items.slice(0,12).map(function(it){return"<span>"+esc(it.id)+"</span>"}).join("")+(n>12?'<span class="muted">+'+(n-12)+' more</span>':"");
  $("iOk").disabled=!n||n>MAX_IDS||creating;
}
function closeImport(){$("importPanel").hidden=true;$("importPanel").innerHTML="";jobs=[];creating=false}
function createTask(){
  if(creating)return;
  var r=computeImport(),n=r.items.length;if(!n||n>MAX_IDS)return;
  var name=($("tkName").value||"").trim();
  if(!name){toast("Give the task a name");$("tkName").focus();return}
  var assign=$("tkAssign").value||null;
  creating=true;var b=$("iOk");b.disabled=true;b.textContent="Creating task…";
  var ref=doc(collection(fs,"tasks")),tid=ref.id,parts=Math.ceil(n/PART_SIZE);
  queueWrite(function(){
    /* list and progress first, the task itself last, so packers only see it once it is complete */
    var b1=writeBatch(fs);
    for(var i=0;i<parts;i++){
      var chunk=r.items.slice(i*PART_SIZE,(i+1)*PART_SIZE).map(function(it){return{i:it.id,s:it.src}});
      b1.set(D("tasks/"+tid+"/parts/p"+i),{items:chunk});
      b1.set(D("tasks/"+tid+"/progress/p"+i),{scans:{}});
    }
    b1.set(D("tasks/"+tid+"/progress/extras"),{extras:{}});
    return b1.commit().then(function(){
      var now=Date.now();
      return setDoc(ref,{name:name,createdBy:me.email,createdAt:now,assignedTo:assign,status:"open",packer:null,acceptedAt:null,doneAt:null,total:n,scanned:0,extra:0,parts:parts,updatedAt:now});
    });
  }).then(function(){
    closeImport();mgrFilter="active";renderBoards();toast("Created "+name+" with "+n+" tracking IDs");
  },function(){creating=false;b.disabled=false;b.textContent="Create task"});
}
$("newTaskBtn").addEventListener("click",function(){$("fileInput").click()});
$("fileInput").addEventListener("change",function(){var f=this.files;handleFiles(f);this.value=""});

/* ---------- copy + export ---------- */
function showFallback(text){var f=$("fallback"),t=$("fbText");t.value=text;f.hidden=false;t.focus();t.select()}
function copyText(text,msg){
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){toast(msg)},function(){showFallback(text)})}
  else showFallback(text);
}
function sortedForReport(){
  var pend=cur.list.filter(function(i){return!i.s}),done=cur.list.filter(function(i){return i.s}).sort(function(a,b){return a.s[0]-b.s[0]});
  return{pend:pend,done:done};
}
function copyPending(){
  if(!cur||!cur.loaded)return;
  var s=sortedForReport();
  if(!s.pend.length){toast("Nothing to copy: every packet is scanned");return}
  copyText(s.pend.map(function(i){return i.id}).join("\n"),"Copied "+s.pend.length+" tracking IDs");
}
function copyTable(){
  if(!cur||!cur.loaded)return;
  var s=sortedForReport(),L=["Tracking ID\tStatus\tScanned at\tSource"];
  s.pend.forEach(function(i){L.push([i.id,"Not scanned","",i.src||""].join("\t"))});
  s.done.forEach(function(i){L.push([i.id,i.s[1]?"Scanned (by hand)":"Scanned",fmtFull(i.s[0]),i.src||""].join("\t"))});
  extrasList().forEach(function(i){L.push([i.id,"Not in list",fmtFull(i.at),""].join("\t"))});
  if(L.length===1){toast("Nothing to copy yet");return}
  copyText(L.join("\n"),"Copied "+(L.length-1)+" rows");
}
function exportReport(){
  if(!cur||!cur.loaded)return;
  var t=cur.task;
  needXlsx().then(function(){
    var s=sortedForReport(),c=counts(),wb=XLSX.utils.book_new();
    function sheet(name,rows,w){var ws=XLSX.utils.aoa_to_sheet(rows);ws["!cols"]=w.map(function(x){return{wch:x}});XLSX.utils.book_append_sheet(wb,ws,name)}
    sheet("Summary",[["Packet scan report"],["Task",t.name],["Created by",t.createdBy||""],["Packer",t.packer||""],["Status",t.status==="done"?"Done":t.status==="accepted"?"In progress":"Open"],["Report created",fmtFull(Date.now())],[],["On the list",c.total],["Scanned",c.scanned],["Not scanned",c.pending],["Not in list",c.extra]],[16,36]);
    sheet("Not scanned",[["Tracking ID","Source"]].concat(s.pend.map(function(i){return[i.id,i.src||""]})),[28,40]);
    sheet("Scanned",[["Tracking ID","Scanned at","Marked by hand","Source"]].concat(s.done.map(function(i){return[i.id,fmtFull(i.s[0]),i.s[1]?"Yes":"No",i.src||""]})),[28,22,16,40]);
    sheet("Not in list",[["Tracking ID","First scanned at","Times scanned"]].concat(extrasList().map(function(i){return[i.id,fmtFull(i.at),i.count]})),[28,22,14]);
    var out=XLSX.write(wb,{bookType:"xlsx",type:"array"});
    var safe=String(t.name).replace(/[^A-Za-z0-9 _.-]+/g," ").trim().slice(0,60)||"packet-scan-report";
    var blob=new Blob([out],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
    var url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download=safe+" report.xlsx";document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){URL.revokeObjectURL(url)},5000);
  }).then(function(){toast("Report downloaded")},function(e){
    toast("Could not create the report: "+((e&&e.message)||"unknown error"));
  });
}

/* ---------- camera scanning ---------- */
function camError(msg){var e=$("camErr");e.textContent=msg;e.hidden=!msg}
function setWake(on){
  try{
    if(on&&navigator.wakeLock&&!cam.wake){navigator.wakeLock.request("screen").then(function(w){cam.wake=w;w.addEventListener("release",function(){cam.wake=null})},function(){})}
    else if(!on&&cam.wake){cam.wake.release();cam.wake=null}
  }catch(e){}
}
function onCamCode(text){
  var now=Date.now();
  if(text===cam.lastCode&&now-cam.lastAt<2500){cam.lastAt=now;return}
  cam.lastCode=text;cam.lastAt=now;
  try{if(navigator.vibrate)navigator.vibrate(40)}catch(e){}
  handleScan(text);
}
function camMessage(e){
  var s=String(e&&e.name?e.name+": "+(e.message||""):e);
  if(!window.isSecureContext)return"The camera only works on a secure (https) page. Open this app from its https link.";
  if(/NotAllowed|Permission|denied/i.test(s))return"Camera permission was blocked. Allow the camera for this site in your browser settings, then tap Scan with camera again.";
  if(/NotFound|no camera|Requested device not found/i.test(s))return"No camera was found on this device.";
  if(/NotReadable|in use|Could not start/i.test(s))return"The camera is busy. Close other apps or tabs that use it and try again.";
  return"Could not start the camera: "+s;
}
function qrFormats(){
  var F=window.Html5QrcodeSupportedFormats;
  return[F.CODE_128,F.CODE_39,F.CODE_93,F.EAN_13,F.EAN_8,F.UPC_A,F.UPC_E,F.ITF,F.CODABAR,F.QR_CODE,F.DATA_MATRIX];
}
function startCamera(){
  if(cam.on||cam.starting)return;
  camError("");cam.starting=true;
  var btn=$("camBtn");btn.disabled=true;btn.textContent="Starting camera…";
  loadScript(QR_URL).then(function(){
    cam.h=new window.Html5Qrcode("reader",{formatsToSupport:qrFormats(),experimentalFeatures:{useBarCodeDetectorIfSupported:true},verbose:false});
    $("camBox").hidden=false;document.body.classList.add("cam-on");
    var scan={fps:10,qrbox:function(vw,vh){var ch=$("reader").clientHeight||150;return{width:Math.max(80,Math.floor(vw*0.9)),height:Math.max(60,Math.floor(Math.min(vh,ch)*0.8))}}};
    function go(extra){
      var c=Object.assign({},scan,extra||{});
      return cam.h.start({facingMode:"environment"},c,onCamCode,function(){});
    }
    return go({videoConstraints:{facingMode:"environment",width:{ideal:1280},height:{ideal:720}}}).catch(function(e){
      if(/NotAllowed|Permission|denied|NotFound/i.test(String(e)))throw e;
      return go();
    });
  }).then(function(){
    cam.on=true;cam.starting=false;btn.disabled=false;btn.textContent="Stop camera";
    setWake(true);
    try{
      var tf=cam.h.getRunningTrackCameraCapabilities().torchFeature();
      if(tf&&tf.isSupported()){cam.torch=false;$("torchBtn").textContent="Torch on";$("torchBtn").hidden=false}
    }catch(e){}
  }).catch(function(e){
    cam.starting=false;cam.on=false;btn.disabled=false;btn.textContent="Scan with camera";
    $("camBox").hidden=true;document.body.classList.remove("cam-on");camError(camMessage(e));
    try{if(cam.h){cam.h.clear()}}catch(x){}
    cam.h=null;
  });
}
function stopCamera(){
  setWake(false);$("torchBtn").hidden=true;cam.torch=false;
  var h=cam.h;cam.h=null;cam.on=false;cam.starting=false;
  var btn=$("camBtn");btn.disabled=false;btn.textContent="Scan with camera";$("camBox").hidden=true;document.body.classList.remove("cam-on");$("camFrame").className="camframe";
  if(!h)return Promise.resolve();
  return h.stop().then(function(){try{h.clear()}catch(e){}},function(){try{h.clear()}catch(e){}});
}
function toggleTorch(){
  try{
    var tf=cam.h.getRunningTrackCameraCapabilities().torchFeature();
    tf.apply(!cam.torch).then(function(){cam.torch=!cam.torch;$("torchBtn").textContent=cam.torch?"Torch off":"Torch on"},function(){toast("Torch is not available on this camera")});
  }catch(e){toast("Torch is not available on this camera")}
}
function scanPhoto(file){
  if(!file)return;
  camError("");
  var b=$("photoBtn");b.disabled=true;b.textContent="Reading photo…";
  loadScript(QR_URL).then(function(){
    var r=new window.Html5Qrcode("photoReader",{formatsToSupport:qrFormats(),experimentalFeatures:{useBarCodeDetectorIfSupported:true},verbose:false});
    return r.scanFile(file,false).then(function(text){try{r.clear()}catch(e){}return text},function(e){try{r.clear()}catch(x){}throw e});
  }).then(function(text){handleScan(text)},function(){
    showResult("bad","No barcode found","","Take the photo closer, keep the barcode flat and sharp, and try again.");beep("bad");
  }).then(function(){b.disabled=false;b.textContent="Scan from photo"});
}

/* ---------- events ---------- */
$("exportBtn").addEventListener("click",exportReport);
$("scanBtn").addEventListener("click",function(){submitScanInput();$("scanInput").focus()});
/* handheld scanners type the code in a fast burst; many send no Enter, so submit once the burst stops.
   Typing by hand is slower than BURST_MS per character and still waits for Enter. */
var BURST_MS=60,IDLE_MS=250,burst={t0:0,n:0,timer:0};
function submitScanInput(){
  var i=$("scanInput");clearTimeout(burst.timer);burst.timer=0;burst.n=0;
  var v=i.value;i.value="";
  if(v.trim())handleScan(v);
}
$("scanInput").addEventListener("keydown",function(e){
  if(e.key==="Enter"||e.keyCode===13||e.key==="Tab"&&this.value.trim()){e.preventDefault();submitScanInput()}
});
$("scanInput").addEventListener("input",function(){
  var now=Date.now(),len=this.value.length;
  if(!len){burst.n=0;return}
  if(/[\r\n]/.test(this.value)){submitScanInput();return}
  if(burst.n===0||len<=1)burst.t0=now;
  burst.n=len;
  clearTimeout(burst.timer);
  burst.timer=setTimeout(function(){
    var i=$("scanInput"),v=i.value,el=Date.now()-IDLE_MS-burst.t0;
    /* whole code pasted at once, or every character arrived faster than a person types */
    if(v.trim().length>=4&&(burst.n>1&&el/(burst.n-1)<BURST_MS||el<=0))submitScanInput();
  },IDLE_MS);
});
$("scanInput").addEventListener("focus",function(){setReady(true)});
$("scanInput").addEventListener("blur",function(){setReady(false)});
$("undoBtn").addEventListener("click",function(){doUndo();if(!coarse)$("scanInput").focus()});
$("camBtn").addEventListener("click",function(){audioCtx();if(cam.on)stopCamera();else startCamera()});
$("photoBtn").addEventListener("click",function(){audioCtx();if(cam.on)stopCamera();$("photoInput").click()});
$("photoInput").addEventListener("change",function(){var f=this.files&&this.files[0];scanPhoto(f);this.value=""});
$("torchBtn").addEventListener("click",toggleTorch);
$("testOk").addEventListener("click",function(){beep("ok")});
$("testBad").addEventListener("click",function(){beep("bad")});
document.addEventListener("visibilitychange",function(){if(!document.hidden&&cam.on)setWake(true)});
$("chips").addEventListener("click",function(e){var b=e.target.closest("button[data-f]");if(!b)return;filter=b.getAttribute("data-f");limit=300;renderTask()});
$("q").addEventListener("input",function(){query=this.value;limit=300;renderTask()});
$("moreBtn").addEventListener("click",function(){limit+=300;renderTask()});
$("rows").addEventListener("click",function(e){var b=e.target.closest("button[data-act=toggle]");if(b)toggleManual(b.getAttribute("data-key"))});
$("copyPending").addEventListener("click",copyPending);
$("copyTable").addEventListener("click",copyTable);
$("fbClose").addEventListener("click",function(){$("fallback").hidden=true});
document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!$("fallback").hidden){$("fallback").hidden=true}});
document.addEventListener("click",function(e){
  if(!cur||isReadOnly()||!$("fallback").hidden||cam.on||cam.starting||coarse||renaming)return;
  var t=e.target;if(t&&t.closest&&t.closest("input,select,textarea,button,a,label"))return;
  $("scanInput").focus({preventScroll:true});
});

var depth=0;
function canDrop(){return me&&me.role==="manager"&&!cur}
function hasFiles(e){var t=e.dataTransfer&&e.dataTransfer.types;return!!t&&Array.prototype.indexOf.call(t,"Files")>=0}
window.addEventListener("dragenter",function(e){if(hasFiles(e)&&canDrop()){depth++;$("drop").hidden=false}});
window.addEventListener("dragleave",function(e){if(hasFiles(e)){depth=Math.max(0,depth-1);if(!depth)$("drop").hidden=true}});
window.addEventListener("dragover",function(e){if(hasFiles(e))e.preventDefault()});
window.addEventListener("drop",function(e){if(hasFiles(e)){e.preventDefault();depth=0;$("drop").hidden=true;if(canDrop())handleFiles(e.dataTransfer.files)}});

/* ---------- start ---------- */
(function start(){
  if(!firebaseConfig||!firebaseConfig.apiKey||/^PASTE/.test(firebaseConfig.apiKey)){
    show("loginView",false);show("setupView",true);return;
  }
  var app=initializeApp(firebaseConfig);
  auth=getAuth(app);fs=getFirestore(app);
  show("loginView",false);
  onAuthStateChanged(auth,function(u){
    var role=u&&roleOf(u.email);
    if(u&&!role){signOut(auth);$("lgErr").textContent="This account has no role in the app.";$("lgErr").hidden=false;return}
    if(u){
      me={email:u.email.toLowerCase(),role:role};
      tasksLoaded=false;tasks=[];subscribeTasks();
    }else{
      leaveTask();me=null;tasks=[];tasksLoaded=false;
      if(tasksUnsub){tasksUnsub();tasksUnsub=null}
      setBanner("");
    }
    route();
    if(!me){try{$("lgEmail").focus({preventScroll:true})}catch(e){}}
  });
})();
