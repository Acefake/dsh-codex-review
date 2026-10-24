from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px=im.load(); W,H=im.size
def col_runs(x,y0,y1,tol=3,minrun=2):
    out=[];start=y0;prev=px[x,y0]
    for y in range(y0+1,y1):
        c=px[x,y]
        if max(abs(c[i]-prev[i]) for i in range(3))>tol:
            if y-start>=minrun: out.append((start,y-1,prev))
            start=y;prev=c
    out.append((start,y1-1,prev)); return out
def row_runs(y,x0,x1,tol=3,minrun=2):
    out=[];start=x0;prev=px[x0,y]
    for x in range(x0+1,x1):
        c=px[x,y]
        if max(abs(c[i]-prev[i]) for i in range(3))>tol:
            if x-start>=minrun: out.append((start,x-1,prev))
            start=x;prev=c
    out.append((start,x1-1,prev)); return out
print("=== A. composer bar column x=2100 ===")
for r in col_runs(2100,1380,1528): print("  ",r)
print("=== B. composer bar row y=1460 ===")
for r in row_runs(1460,1500,2560): 
    if r[1]-r[0]>=2: print("  ",r)
print("=== C. right panel column x=1900 (through labels) ===")
for r in col_runs(1900,230,1000): 
    if r[1]-r[0]>=1: print("  ",r)
print("=== D. right panel dividers: row y=250..1000 find x-extent of non-bg runs on likely divider rows ===")
for y in range(230,1000):
    row=row_runs(y,1800,2560,3,4)
    light=[(a,b,c) for a,b,c in row if 26<=c[0]<=70]
    if light:
        print("  y",y,light)
