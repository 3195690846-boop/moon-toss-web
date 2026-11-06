export const OUTCOMES = Object.freeze({
  sheng: { name:'圣筊', roman:'SHENG JIAO', short:'一平一凸', meaning:'传统上表示应允或肯定。', copy:'一平一凸，相映成筊。民俗中，人们将这样的组合读作应允，也提醒自己带着清楚的心意继续前行。', faces:['flat','rounded'] },
  xiao: { name:'笑筊', roman:'XIAO JIAO', short:'两面皆平', meaning:'传统上表示笑而未决，可澄清问题后再问。', copy:'两枚平面朝上，如同一个温和的停顿。民俗中常解释为问题还不够清楚，可以整理心意，再问一次。', faces:['flat','flat'] },
  yin: { name:'阴筊', roman:'YIN JIAO', short:'两面皆凸', meaning:'传统上表示未获应允或暂缓。', copy:'两枚凸面朝上，民俗中常解释为未获应允。不妨留一点时间，重新想一想自己的问题与选择。', faces:['rounded','rounded'] }
});
export function classify(a,b) {
  if (![a,b].every(f=>['flat','rounded'].includes(f))) throw new Error('需要两枚有效杯面');
  return a!==b?'sheng':a==='flat'?'xiao':'yin';
}
export function digitalFaces(random = () => crypto.getRandomValues(new Uint8Array(1))[0]) {
  return [random() & 1 ? 'flat':'rounded', random() & 1 ? 'flat':'rounded'];
}
export function makeRecord(faces,question='',now=Date.now(),id=crypto.randomUUID()) {
  return {id,timestamp:now,source:'simulation',outcome:classify(...faces),faces:[...faces],question:question.trim().slice(0,160)};
}
export function validRecord(r) {
  return !!r && typeof r.id==='string' && r.source==='simulation' && Number.isFinite(r.timestamp) && r.timestamp>0 && typeof r.question==='string' && r.question.length<=160 && Array.isArray(r.faces) && r.faces.length===2 && r.faces.every(f=>['flat','rounded'].includes(f)) && r.outcome===classify(...r.faces);
}
export function readRecords(storage) {
  try { const data=JSON.parse(storage.getItem('moon-toss.records.v1')||'[]');
    const seen=new Set();return Array.isArray(data)?data.filter(r=>{if(!validRecord(r)||seen.has(r.id))return false;seen.add(r.id);return true;}).slice(0,500):[];
  } catch {return [];}
}
export function appendRecord(records, record) { if(!validRecord(record))throw new Error('记录无效'); return [record,...records.filter(r=>r.id!==record.id)].slice(0,500); }
export function statistics(records) { return {total:records.length,...Object.fromEntries(Object.keys(OUTCOMES).map(k=>[k,records.filter(r=>r.outcome===k).length]))}; }
