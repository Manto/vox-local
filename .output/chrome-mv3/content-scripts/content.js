var content=(function(){"use strict";function se(t){return t}const j={matches:["<all_urls>"],main:()=>{console.log("[VoxLocal] Content script loaded on",window.location.href);let t=null,n=!1,r=!1,i=0,g=0,w=0,N=0,u=null,m={},p=!1,v=null,b=0,y=0,x=0;function Q(e,{speed:o=1}={}){try{const l=atob(e),a=new ArrayBuffer(l.length),d=new Uint8Array(a);for(let V=0;V<l.length;V++)d[V]=l.charCodeAt(V);const c=new Blob([d],{type:"audio/wav"}),f=URL.createObjectURL(c),G=new Audio(f);return G.playbackRate=o,{audio:G,audioUrl:f}}catch(l){throw console.error("[VoxLocal] Error creating audio from base64:",l),l}}chrome.runtime.onMessage.addListener((e,o,l)=>{if(e.action||e.type){const a=e.action||e.type;switch(console.log("[VoxLocal] Received message:",e),a){case"GET_SELECTION":return l({text:T()}),!0;case"GET_PAGE_TEXT":return l({text:Y()}),!0;case"TOGGLE_PLAYER":return J(),l({success:!0}),!0;case"SHOW_PLAYER":P();break;case"PLAY_SELECTION":P(),(p||u)&&D(),A("selection");break;case"stream_chunk":if(!p||e.requestId!==v)return;console.log(`[VoxLocal] 📦 Processing streaming chunk ${e.chunkIndex+1}/${e.totalChunks}`),b=Math.max(b,e.chunkIndex+1),y=e.totalChunks,m[e.chunkIndex]=e,console.log(`[VoxLocal] ➕ Stored chunk ${e.chunkIndex+1}. Total chunks stored: ${Object.keys(m).length}/${y}`),s(`Processing chunks: ${b}/${y} received`,"loading"),!u&&m[x]&&(console.log(`[VoxLocal] ▶️ ${x===0?"Starting":"Resuming"} playback - chunk ${x+1} available`),z());break;case"stream_complete":console.log(`[VoxLocal] Streaming complete (requestId: ${e.requestId})`),e.requestId===v?(p=!1,v=null,u||(s("Ready","ready"),M())):console.log(`[VoxLocal] 🚫 Ignoring stream_complete - wrong request ID (expected: ${v}, got: ${e.requestId})`);break;case"stream_error":console.error(`[VoxLocal] Streaming error (requestId: ${e.requestId}):`,e.error),e.requestId===v?(s("Streaming error: "+e.error,"error"),h()):console.log(`[VoxLocal] 🚫 Ignoring stream_error - wrong request ID (expected: ${v}, got: ${e.requestId})`);break;default:console.log("[VoxLocal] Unknown action:",e.action)}return!1}return console.log("[VoxLocal] Received unknown message format:",e),!0});function J(){n?F():P()}function P(){if(t){t.style.display="block",n=!0;return}K(),n=!0}function F(){t&&(t.style.display="none",n=!1)}function K(){t=document.createElement("div"),t.id="voxlocal-floating-player",t.innerHTML=`
        <div class="voxlocal-header">
            <span class="voxlocal-title">🎙️ VoxLocal</span>
            <button class="voxlocal-close-btn" title="Close">&times;</button>
        </div>
        <div class="voxlocal-status-section">
            <div id="voxlocal-status" class="status-badge ready">Ready</div>
        </div>
        <div class="voxlocal-controls">
            <button id="voxlocal-play-stop-btn" class="voxlocal-btn voxlocal-btn-primary" title="Play selection or page">
                <img src="" class="icon" alt="Play"> Play
            </button>
        </div>
        <div class="voxlocal-settings">
            <div class="voxlocal-setting-item">
                <div class="voxlocal-setting-display" id="voxlocal-voice-display">
                    <div class="setting-value">Heart</div>
                    <div class="setting-label">voice</div>
                </div>
                <select id="voxlocal-voice-select" class="voxlocal-setting-control hidden">
                    <option value="af_heart">Heart (Female)</option>
                    <option value="af_bella">Bella (Female)</option>
                    <option value="am_michael">Michael (Male)</option>
                    <option value="am_fenrir">Fenrir (Male)</option>
                    <option value="bf_emma">Emma (British Female)</option>
                    <option value="bm_george">George (British Male)</option>
                </select>
            </div>
            <div class="voxlocal-setting-item">
                <div class="voxlocal-setting-display" id="voxlocal-speed-display">
                    <div class="setting-value">1.0x</div>
                    <div class="setting-label">speed</div>
                </div>
                <input type="range" id="voxlocal-speed-slider" class="voxlocal-setting-control hidden" min="0.75" max="1.25" step="0.05" value="1.0">
            </div>
        </div>
    `,Z(),document.body.appendChild(t),ee(),ce(),s("Ready"),_(),re()}function Z(){const e=document.createElement("style");e.textContent=`
        #voxlocal-floating-player {
            position: fixed;
            top: 20px;
            left: auto;
            right: 20px;
            width: 240px;
            background: white;
            border: 1px solid #dee2e6;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 10000;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            line-height: 1.4;
            color: #212529;
        }

        .voxlocal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 12px 8px 12px;
            border-bottom: 1px solid #dee2e6;
        }

        .voxlocal-header .voxlocal-title {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
        }

        .voxlocal-close-btn {
            background: none;
            border: none;
            font-size: 24px;
            cursor: pointer;
            color: #6c757d;
            padding: 0;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .voxlocal-close-btn:hover {
            color: #dc3545;
        }

        .voxlocal-status-section {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin: 12px;
        }

        .status-badge {
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 500;
            text-align: center;
        }

        .status-badge.ready { background-color: #28a745; color: white; }
        .status-badge.loading { background-color: #ffc107; color: black; }
        .status-badge.speaking { background-color: #007bff; color: white; }
        .status-badge.error { background-color: #dc3545; color: white; }

        .voxlocal-controls {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin: 0 12px 16px 12px;
        }

        .voxlocal-btn {
            padding: 4px 12px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        .voxlocal-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .voxlocal-btn-primary { background-color: #007bff; color: white; }
        .voxlocal-btn-primary:hover:not(:disabled) { background-color: #0056b3; }
        .voxlocal-btn-danger { background-color: #dc3545; color: white; }
        .voxlocal-btn-danger:hover:not(:disabled) { background-color: #c82333; }

        .icon {
            font-size: 48px;
            width: 48px;
            height: 48px;
            vertical-align: middle;
            margin-right: 4px;
        }

        .icon img {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }

        .voxlocal-input-section { margin: 0 16px 20px 16px; }

        #voxlocal-text {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid #dee2e6;
            border-radius: 4px;
            font-size: 13px;
            line-height: 1.4;
            resize: vertical;
            min-height: 60px;
            background: white;
            box-sizing: border-box;
        }

        .voxlocal-settings {
            margin: 0 12px 12px 12px;
            padding-top: 12px;
            border-top: 1px solid #dee2e6;
            display: flex;
            gap: 16px;
        }

        .voxlocal-setting-item {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            position: relative;
        }

        .voxlocal-setting-display {
            display: flex;
            flex-direction: column;
            align-items: center;
            cursor: pointer;
            padding: 8px;
            border-radius: 6px;
            transition: background-color 0.2s ease;
            min-height: 50px;
            justify-content: center;
        }

        .voxlocal-setting-display:hover {
            background-color: #f8f9fa;
        }

        .setting-value {
            font-size: 16px;
            font-weight: 600;
            color: #212529;
            text-align: center;
        }

        .setting-label {
            font-size: 11px;
            color: #6c757d;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-top: 2px;
            text-align: center;
        }

        .voxlocal-setting-control {
            position: absolute;
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
            width: 140px;
            padding: 12px;
            border: 1px solid #dee2e6;
            border-radius: 6px;
            font-size: 13px;
            background: white;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 10001;
            box-sizing: border-box;
            margin-top: 4px;
        }

        .voxlocal-setting-control.hidden {
            display: none;
        }

        .setting-note {
            display: block;
            margin-top: 2px;
            font-size: 11px;
            color: #6c757d;
            font-style: italic;
        }
    `,document.head.appendChild(e)}function ee(){t.querySelector(".voxlocal-close-btn").addEventListener("click",F);const e=t.querySelector(".voxlocal-header");e.style.cursor="move",e.addEventListener("pointerdown",te),document.addEventListener("pointermove",oe),document.addEventListener("pointerup",ne);const o=document.getElementById("voxlocal-voice-display"),l=document.getElementById("voxlocal-voice-select");o.addEventListener("click",c=>{c.stopPropagation(),U(l)});const a=document.getElementById("voxlocal-speed-display"),d=document.getElementById("voxlocal-speed-slider");a.addEventListener("click",c=>{c.stopPropagation(),U(d)}),d.addEventListener("input",c=>{R(c.target.value)}),d.addEventListener("pointerup",()=>{I()}),t.addEventListener("click",c=>{c.target.closest(".voxlocal-setting-display")||I()}),document.querySelectorAll(".voxlocal-setting-control").forEach(c=>{c.addEventListener("click",f=>f.stopPropagation())}),document.getElementById("voxlocal-play-stop-btn").addEventListener("click",ie),l.addEventListener("change",()=>{B(),O(),I()}),d.addEventListener("change",O),document.addEventListener("selectionchange",_)}function te(e){if(e.target.closest(".voxlocal-close-btn"))return;r=!0,i=e.clientX,g=e.clientY;const o=t.getBoundingClientRect();w=o.left,N=o.top,e.preventDefault(),document.body.style.userSelect="none"}function oe(e){if(!r)return;const o=e.clientX-i,l=e.clientY-g,a=w+o,d=N+l,c=window.innerWidth-t.offsetWidth,f=window.innerHeight-t.offsetHeight;t.style.left=Math.max(0,Math.min(a,c))+"px",t.style.top=Math.max(0,Math.min(d,f))+"px",t.style.right="auto"}function ne(){r&&(r=!1,document.body.style.userSelect="")}function U(e){const o=e.classList.contains("hidden");I(),o&&e.classList.remove("hidden")}function I(){document.querySelectorAll(".voxlocal-setting-control").forEach(e=>{e.classList.add("hidden")})}function B(){const e=document.getElementById("voxlocal-voice-select"),o=document.getElementById("voxlocal-voice-display").querySelector(".setting-value"),a=e.options[e.selectedIndex].text.split(" (")[0];o.textContent=a}function R(e){const o=document.getElementById("voxlocal-speed-display").querySelector(".setting-value");o.textContent=`${e}x`}function T(){const e=window.getSelection();return e?e.toString().trim():""}function le(){console.log("[VoxLocal] Cancelling streaming TTS request");const e={action:"cancel_stream"};chrome.runtime.sendMessage(e,o=>{chrome.runtime.lastError&&console.error("[VoxLocal] Error sending cancel message:",chrome.runtime.lastError)})}function re(){console.log("[VoxLocal] Querying model status from background");const e={action:"query_model_status"};chrome.runtime.sendMessage(e,o=>{if(chrome.runtime.lastError){console.error("[VoxLocal] Error querying model status:",chrome.runtime.lastError);return}o&&o.loaded&&o.modelName&&`${o.modelName}`})}function ae(e,o,l){const a=Date.now()+Math.random();m={},x=0,v=a,p=!0,b=0,y=0,M(),s("Starting streaming speech (processing in chunks)...","loading");const d={action:"speak_stream",requestId:a,text:e,voice:o,speed:l};console.log(`[VoxLocal] Sending streaming speak message to background script - text: "${e.substring(0,50)}${e.length>50?"...":""}", voice: ${o}, speed: ${l}x`),chrome.runtime.sendMessage(d,c=>{if(chrome.runtime.lastError){console.error("[VoxLocal] Runtime error:",chrome.runtime.lastError),s("Error: "+chrome.runtime.lastError.message,"error"),h();return}(!c||!c.success)&&(console.error("[VoxLocal] Streaming TTS failed:",c?.error),s("Error: "+(c?.error||"Streaming failed"),"error"),h())})}async function A(e){const o=document.getElementById("voxlocal-voice-select").value,l=parseFloat(document.getElementById("voxlocal-speed-slider").value);s(e==="selection"?"Getting selected text...":"Getting page text...","loading");try{let a;if(e==="selection"?a=T():a=Y(),!a||a.trim()===""){s(e==="selection"?"No text selected":"No text found on page","error"),setTimeout(()=>s("Ready","ready"),2e3),E();return}const d=a.trim();console.log(`[VoxLocal] Got ${e} text: "${d.substring(0,50)}${d.length>50?"...":""}"`),ae(d,o,l)}catch(a){console.error("[VoxLocal] Error:",a),s("Error: "+a.message,"error"),E()}}function ie(){if(p||u){console.log("[VoxLocal] Play/Stop button clicked - stopping playback"),D();return}const e=T();e&&e.trim()!==""?(console.log("[VoxLocal] Play/Stop button clicked - playing selection"),A("selection")):(console.log("[VoxLocal] Play/Stop button clicked - playing page"),A("page"))}function D(){console.log("[VoxLocal] Stop button clicked"),u&&(console.log("[VoxLocal] Stopping current audio playback"),u.pause(),u=null),p?(console.log("[VoxLocal] Cancelling active streaming request"),le(),h()):E(),s("Stopped","ready")}function _(){const e=document.getElementById("voxlocal-play-stop-btn");if(!e||p)return;const o=T(),l=o&&o.trim()!==""?"Play Selection":"Play Page",a=chrome.runtime.getURL("icons/icon_128x128_2.png");e.innerHTML=`<img src="${a}" class="icon" alt="Play"> ${l}`}function E(){const e=document.getElementById("voxlocal-play-stop-btn");e.disabled=!1,_(),e.title="Play selection or page",e.className="voxlocal-btn voxlocal-btn-primary"}function s(e,o="ready"){const l=document.getElementById("voxlocal-status");l&&(l.textContent=e,l.className="status-badge",l.classList.add(o))}function h(){m={},x=0,v=null,p=!1,b=0,y=0,M()}function M(){const e=document.getElementById("voxlocal-play-stop-btn");if(p){e.disabled=!1;const o=chrome.runtime.getURL("icons/voxlocal-stop.png");e.innerHTML=`<img src="${o}" class="icon" alt="Stop"> Stop`,e.title="Stop speaking",e.className="voxlocal-btn voxlocal-btn-danger"}else E()}function z(){if(!m[x]){p?s("Streaming: waiting for next chunk...","loading"):x>=y&&(s("Ready","ready"),E());return}const e=m[x];delete m[x],x++,console.log(`[VoxLocal] 📝 Chunk text: "${e.text?e.text.substring(0,100)+(e.text.length>100?"...":""):"N/A"}"`),s(`Playing chunk ${e.chunkIndex+1}/${e.totalChunks} (streaming)`,"speaking");try{const{audio:o,audioUrl:l}=Q(e.audio,{speed:e.speed||1});u=o,u.onended=()=>{console.log(`[VoxLocal] ✅ Chunk ${e.chunkIndex+1}/${e.totalChunks} playback COMPLETED`),URL.revokeObjectURL(l),u=null,console.log(`[VoxLocal] 🔄 Calling playNextAudioChunk after chunk ${e.chunkIndex+1} completion`),z()},u.onerror=a=>{console.error("[VoxLocal] Audio chunk playback error:",a),URL.revokeObjectURL(l),u=null,h(),s("Error playing audio chunk","error")},console.log(`[VoxLocal] ▶️ Starting chunk ${e.chunkIndex+1} audio playback...`),u.play().then(()=>{console.log(`[VoxLocal] 🎧 Chunk ${e.chunkIndex+1} STARTED playing successfully`)}).catch(a=>{console.error(`[VoxLocal] ❌ Audio chunk ${e.chunkIndex+1} play FAILED:`,a.message),URL.revokeObjectURL(l),u=null,h(),s("Error: "+a.message,"error")})}catch(o){console.error("[VoxLocal] Error creating audio chunk:",o),h(),s("Error: "+o.message,"error")}}async function O(){const e={voice:document.getElementById("voxlocal-voice-select").value,speed:parseFloat(document.getElementById("voxlocal-speed-slider").value)};try{await chrome.storage.sync.set({voxLocalSettings:e}),console.log("[VoxLocal] Settings saved:",e)}catch(o){console.error("[VoxLocal] Error saving settings:",o)}}async function ce(){try{const o=(await chrome.storage.sync.get("voxLocalSettings")).voxLocalSettings||{};document.getElementById("voxlocal-voice-select").value=o.voice||"af_heart",document.getElementById("voxlocal-speed-slider").value=o.speed||1,B(),R(document.getElementById("voxlocal-speed-slider").value),console.log("[VoxLocal] Settings loaded:",o)}catch(e){console.error("[VoxLocal] Error loading settings:",e),document.getElementById("voxlocal-voice-select").value="af_heart",document.getElementById("voxlocal-speed-slider").value=1,B(),R(1)}}function Y(){const e=document.body.cloneNode(!0);["script","style","noscript","iframe","nav","header","footer","aside",'[role="navigation"]','[role="banner"]','[role="complementary"]'].forEach(a=>{e.querySelectorAll(a).forEach(d=>d.remove())});let l=e.textContent||"";return l=l.replace(/\n\s*\n/g,`

`).replace(/[ \t]+/g," ").trim(),l}}},q=globalThis.browser?.runtime?.id?globalThis.browser:globalThis.chrome;function S(t,...n){}const H={debug:(...t)=>S(console.debug,...t),log:(...t)=>S(console.log,...t),warn:(...t)=>S(console.warn,...t),error:(...t)=>S(console.error,...t)};class C extends Event{constructor(n,r){super(C.EVENT_NAME,{}),this.newUrl=n,this.oldUrl=r}static EVENT_NAME=$("wxt:locationchange")}function $(t){return`${q?.runtime?.id}:content:${t}`}function X(t){let n,r;return{run(){n==null&&(r=new URL(location.href),n=t.setInterval(()=>{let i=new URL(location.href);i.href!==r.href&&(window.dispatchEvent(new C(i,r)),r=i)},1e3))}}}class k{constructor(n,r){this.contentScriptName=n,this.options=r,this.abortController=new AbortController,this.isTopFrame?(this.listenForNewerScripts({ignoreFirstEvent:!0}),this.stopOldScripts()):this.listenForNewerScripts()}static SCRIPT_STARTED_MESSAGE_TYPE=$("wxt:content-script-started");isTopFrame=window.self===window.top;abortController;locationWatcher=X(this);receivedMessageIds=new Set;get signal(){return this.abortController.signal}abort(n){return this.abortController.abort(n)}get isInvalid(){return q.runtime.id==null&&this.notifyInvalidated(),this.signal.aborted}get isValid(){return!this.isInvalid}onInvalidated(n){return this.signal.addEventListener("abort",n),()=>this.signal.removeEventListener("abort",n)}block(){return new Promise(()=>{})}setInterval(n,r){const i=setInterval(()=>{this.isValid&&n()},r);return this.onInvalidated(()=>clearInterval(i)),i}setTimeout(n,r){const i=setTimeout(()=>{this.isValid&&n()},r);return this.onInvalidated(()=>clearTimeout(i)),i}requestAnimationFrame(n){const r=requestAnimationFrame((...i)=>{this.isValid&&n(...i)});return this.onInvalidated(()=>cancelAnimationFrame(r)),r}requestIdleCallback(n,r){const i=requestIdleCallback((...g)=>{this.signal.aborted||n(...g)},r);return this.onInvalidated(()=>cancelIdleCallback(i)),i}addEventListener(n,r,i,g){r==="wxt:locationchange"&&this.isValid&&this.locationWatcher.run(),n.addEventListener?.(r.startsWith("wxt:")?$(r):r,i,{...g,signal:this.signal})}notifyInvalidated(){this.abort("Content script context invalidated"),H.debug(`Content script "${this.contentScriptName}" context invalidated`)}stopOldScripts(){window.postMessage({type:k.SCRIPT_STARTED_MESSAGE_TYPE,contentScriptName:this.contentScriptName,messageId:Math.random().toString(36).slice(2)},"*")}verifyScriptStartedEvent(n){const r=n.data?.type===k.SCRIPT_STARTED_MESSAGE_TYPE,i=n.data?.contentScriptName===this.contentScriptName,g=!this.receivedMessageIds.has(n.data?.messageId);return r&&i&&g}listenForNewerScripts(n){let r=!0;const i=g=>{if(this.verifyScriptStartedEvent(g)){this.receivedMessageIds.add(g.data.messageId);const w=r;if(r=!1,w&&n?.ignoreFirstEvent)return;this.notifyInvalidated()}};addEventListener("message",i),this.onInvalidated(()=>removeEventListener("message",i))}}function ue(){}function L(t,...n){}const W={debug:(...t)=>L(console.debug,...t),log:(...t)=>L(console.log,...t),warn:(...t)=>L(console.warn,...t),error:(...t)=>L(console.error,...t)};return(async()=>{try{const{main:t,...n}=j,r=new k("content",n);return await t(r)}catch(t){throw W.error('The content script "content" crashed on startup!',t),t}})()})();
content;