const {spawn}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const executable=process.argv[2];
if(!executable)throw new Error('Pass the packaged application executable');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'kruzhok-check-'));
const report=path.join(directory,'report.json');
const child=spawn(executable,['--smoke-test','--smoke-report',report],{stdio:'inherit'});
const timer=setTimeout(()=>{child.kill();console.error('Native smoke timed out');process.exitCode=1;},90000);
child.on('error',error=>{clearTimeout(timer);console.error(error);process.exitCode=1;});
child.on('exit',code=>{
 clearTimeout(timer);
 if(!fs.existsSync(report)){console.error('Native smoke did not produce a report; exit',code);process.exitCode=1;return;}
 const result=JSON.parse(fs.readFileSync(report,'utf8'));
 console.log(JSON.stringify(result,null,2));
 if(code!==0||!result.ok)process.exitCode=1;
});
