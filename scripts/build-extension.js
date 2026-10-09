#!/usr/bin/env node
/**
 * build-extension.js — the Chrome extension (the hand mouse for web pages): extension/'s own
 * files, plus the app's tracking, gestures and hand mouse (hand-tracker.js, gestures.js,
 * pc-control.js, web-pc.js), MediaPipe Hands and the app's look (index.html's styles), into
 * dist/extension, and zipped as dist/HandTracker-<version>-chrome-extension.zip (to load in
 * chrome://extensions, or for the Chrome Web Store).
 *
 *   node scripts/build-extension.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist", "extension");
const version = require(path.join(ROOT, "package.json")).version;
const ZIP = path.join(ROOT, "dist", `HandTracker-${version}-chrome-extension.zip`);

const copy = (from, to, edit) => {
  const dest = path.join(OUT, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (edit) fs.writeFileSync(dest, edit(fs.readFileSync(path.join(ROOT, from), "utf8")));
  else fs.copyFileSync(path.join(ROOT, from), dest);
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// The extension's own files (the manifest with the app's version).
for (const f of fs.readdirSync(path.join(ROOT, "extension"), { recursive: true })) {
  const rel = String(f).replace(/\\/g, "/");
  if (fs.statSync(path.join(ROOT, "extension", rel)).isDirectory()) continue;
  if (rel === "manifest.json") copy(`extension/${rel}`, rel, (s) => JSON.stringify({ ...JSON.parse(s), version }, null, 2) + "\n");
  else copy(`extension/${rel}`, rel);
}

// The app's own parts, as they are (MediaPipe's files from vendor/ here).
copy("hand-tracker.js", "hand-tracker.js", (s) => {
  const out = s.replace(/node_modules\/@mediapipe\/hands\//g, "vendor/mediapipe-hands/");
  if (out === s) throw new Error("hand-tracker.js no longer names node_modules/@mediapipe/hands/: update build-extension.js");
  return out;
});
for (const f of ["gestures.js", "pc-control.js", "web-pc.js", "LICENSE", "THIRD_PARTY_NOTICES.md"]) copy(f, f);
const hands = "node_modules/@mediapipe/hands";
// MediaPipe Hands' WebAssembly glue (Emscripten's embind) makes three kinds of function by
// writing their code as text and running it (new Function), which an extension page may not do
// (no 'unsafe-eval'). Each is swapped for the same function made without text, as Emscripten's
// own DYNAMIC_EXECUTION=0 builds do; each original is pinned by its SHA-256 (a MediaPipe update
// that changes one stops the build, rather than leaving the swap undone or wrong).
const EMBIND = [
  {
    // A function with a given name (embind's classes, and the two below).
    from: "function createNamedFunction(", to: "(body)}", sha: "a95503dfa8465a85",
    with: `function createNamedFunction(name,body){name=makeLegalFunctionName(name);return{[name]:function(){"use strict";return body.apply(this,arguments)}}[name]}`,
  },
  {
    // Calling a C++ function from JavaScript: each argument to its wire type, the call, the
    // arguments' destructors, the result from its wire type.
    from: "function craftInvokerFunction(", to: "var invokerFunction=new_(Function,args1).apply(null,args2);return invokerFunction}", sha: "c3b5cdb7cca16a1c",
    with: `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!=="void";var expected=argCount-2;return createNamedFunction(humanName,function(){if(arguments.length!==expected){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expected+" args!")}var destructors=needsDestructorStack?[]:null;var thisWired;var wired=[cppTargetFunc];if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);wired.push(thisWired)}var argsWired=new Array(expected);for(var i=0;i<expected;++i){argsWired[i]=argTypes[i+2].toWireType(destructors,arguments[i]);wired.push(argsWired[i])}var rv=cppInvokerFunc.apply(null,wired);if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var param=i===1?thisWired:argsWired[i-2];if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(param)}}}if(returns){return argTypes[0].fromWireType(rv)}})}`,
  },
  {
    // Calling a JavaScript method from C++: its arguments read from memory, the call, the
    // arguments deleted where their type says, the result to its wire type.
    from: "function __emval_get_method_caller(", to: "emval_registeredMethods[signatureName]=returnId;return returnId}", sha: "b84bba3a36b70206",
    with: `function __emval_get_method_caller(argCount,argTypes){var types=__emval_lookupTypes(argCount,argTypes);var retType=types[0];var signatureName=retType.name+"_$"+types.slice(1).map(function(t){return t.name}).join("_")+"$";var returnId=emval_registeredMethods[signatureName];if(returnId!==undefined){return returnId}var offsets=[];var offset=0;for(var i=0;i<argCount-1;++i){offsets.push(offset);offset+=types[i+1]["argPackAdvance"]}var invokerFunction=createNamedFunction("methodCaller_"+signatureName,function(handle,name,destructors,args){var a=new Array(argCount-1);for(var i=0;i<argCount-1;++i){a[i]=types[i+1].readValueFromPointer(args+offsets[i])}var rv=handle[name].apply(handle,a);for(var i=0;i<argCount-1;++i){if(types[i+1]["deleteObject"]){types[i+1].deleteObject(a[i])}}if(!retType.isVoid){return retType.toWireType(destructors,rv)}});returnId=__emval_addMethodCaller(invokerFunction);emval_registeredMethods[signatureName]=returnId;return returnId}`,
  },
];
const crypto = require("crypto");
function withoutEval(f, s) {
  for (const e of EMBIND) {
    const i = s.indexOf(e.from), j = s.indexOf(e.to, i);
    const original = i < 0 || j < 0 ? "" : s.slice(i, j + e.to.length);
    const sha = crypto.createHash("sha256").update(original).digest("hex").slice(0, 16);
    if (sha !== e.sha || s.indexOf(e.from, i + 1) >= 0) throw new Error(`${f}: ${e.from.slice(9, -1)} isn't the one build-extension.js knows (${sha}): update it`);
    s = s.slice(0, i) + e.with + s.slice(j + e.to.length);
  }
  if (/new Function|new_\(Function|[^\w.]eval\(|[^\w.$]Function\(/.test(s)) throw new Error(`${f} still makes code from text: update build-extension.js`);
  return s;
}
for (const f of fs.readdirSync(path.join(ROOT, hands))) {
  if (!/\.(js|wasm|data|binarypb|tflite)$/.test(f)) continue;
  if (/_wasm_bin\.js$/.test(f)) copy(`${hands}/${f}`, `vendor/mediapipe-hands/${f}`, (s) => withoutEval(f, s));
  else copy(`${hands}/${f}`, `vendor/mediapipe-hands/${f}`);
}
copy("node_modules/@mediapipe/hands/README.md", "vendor/mediapipe-hands/README.md");
copy("node_modules/@mediapipe/drawing_utils/drawing_utils.js", "vendor/mediapipe-drawing/drawing_utils.js");

// The app's look: index.html's styles.
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const style = /<style>([\s\S]*?)<\/style>/.exec(html);
if (!style) throw new Error("index.html has no <style> block: update build-extension.js");
fs.writeFileSync(path.join(OUT, "app.css"), `/* index.html's styles (scripts/build-extension.js) */\n${style[1]}`);

// Every file the control page loads is here (a missing one would only show in Chrome).
const control = fs.readFileSync(path.join(OUT, "control.html"), "utf8");
for (const [, ref] of control.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
  if (!fs.existsSync(path.join(OUT, ref))) throw new Error(`control.html loads ${ref}, which isn't in the extension`);
}

// The zip (stored entries deflated; no zip64: the extension is far below 4 GB).
function zip(dir, file) {
  const entries = [], parts = [];
  let offset = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else entries.push(p);
    }
  };
  walk(dir);
  const central = [];
  for (const p of entries) {
    const name = Buffer.from(path.relative(dir, p).replace(/\\/g, "/"));
    const data = fs.readFileSync(p);
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time, date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0, 12);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, centralBuf, end]));
  return entries.length;
}
const count = zip(OUT, ZIP);
console.log(`Chrome extension: ${count} files in dist/extension, ${(fs.statSync(ZIP).size / 1048576).toFixed(1)} MB as ${path.relative(ROOT, ZIP)}`);
