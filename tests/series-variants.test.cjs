// Reuse the full step-2 interaction suites with recurring occurrences instead of standalone operations.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const kind=process.argv[4]||'payments';
const file=path.join(__dirname,kind==='drag'?'drag.test.cjs':'payments-browser.test.cjs');
let source=fs.readFileSync(file,'utf8');
function replace(from,to){if(!source.includes(from))throw Error('Suite changed; missing '+from);source=source.replace(from,to);}
process.argv[3]=(process.argv[3]||'chrome')+'-recurring';
const conversion=`
seed.data.series=seed.data.operations.map(o=>({id:o.id,versions:[{effectiveFrom:o.plannedDate.slice(0,7),firstMonth:o.plannedDate.slice(0,7),lastMonth:null,rowId:o.rowId,amountMinor:o.amountMinor,dayOfMonth:Number(o.plannedDate.slice(8)),shiftWeekend:false,title:o.title,comment:o.comment}]}));
seed.data.exceptions=seed.data.operations.filter(o=>o.settlements.length).map(o=>({occurrenceKey:o.id+':'+o.plannedDate.slice(0,7),seriesId:o.id,sourceMonth:o.plannedDate.slice(0,7),deleted:false,operation:{...o,id:uuid()}}));
seed.data.operations=[];
`;
if(kind==='drag'){
 replace('const rid=seed.data.rows[0].id','let rid=seed.data.rows[0].id');
 replace('const read=()=>',conversion+"id+=':2026-01';\nconst read=()=>");
 replace('C.clone(r.data.operations[0])','C.clone(C.getOperation(r.data,id))');
 source=source.replaceAll('after.data.operations[0]','C.getOperation(after.data,id)').replaceAll('before.data.operations[0]','C.getOperation(before.data,id)').replaceAll('(await read()).data.operations[0]','C.getOperation((await read()).data,id)');
 replace('A.deepEqual((await read()).data.operations,before.data.operations);','A.deepEqual((await read()).data.operations,before.data.operations);A.deepEqual((await read()).data.exceptions,before.data.exceptions);');
}else{
 replace('const iid=uuid(),eid=uuid()','let iid=uuid(),eid=uuid()');
 replace('const read=()=>',conversion+"iid+=':2026-10';eid+=':2026-10';\nconst read=()=>");
 replace('(await read()).data.operations.find(o=>o.id===id)','C.getOperation((await read()).data,id)');
 replace('A.equal((await read()).data.operations.length,2)','A.equal((await read()).data.series.length,2)');
 replace('A.equal((await read()).data.operations.length,1)','A.equal((await read()).data.exceptions.filter(e=>e.deleted).length,1)');
}
const testModule=new Module(file,module);testModule.filename=file;testModule.paths=module.paths;testModule._compile(source,file);
