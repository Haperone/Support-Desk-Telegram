const DAY=86400000;

// Report limits are calendar days in the selected zone, not fixed 24h units.
// Also bound elapsed time so a malformed interval cannot bypass the limit.
export function withinStatisticsRangeLimit(start,end,timeZone='UTC') {
 const first=Date.parse(start),last=Date.parse(end);
 if(!Number.isFinite(first)||!Number.isFinite(last)||last<first||last-first>367*DAY)return false;
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
 const day=value=>{
   const parts=Object.fromEntries(formatter.formatToParts(new Date(value)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
   return Date.UTC(parts.year,parts.month-1,parts.day);
 };
 return day(last)-day(first)<=366*DAY;
}
