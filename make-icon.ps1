<#
  Draws the app icon (a PDF page with an edit pencil) and writes:
    app\icon.ico   multi-size icon for the window and the built exe
    app\icon.png   256px master, handy for docs/shortcuts

  Usage:  powershell -ExecutionPolicy Bypass -File make-icon.ps1
#>
[CmdletBinding()]
param(
  [string]$IcoPath = '',
  [string]$PngPath = '',
  [string]$PreviewPath = '',
  [int]$MasterSize = 1024
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $IcoPath) { $IcoPath = Join-Path $root 'app\icon.ico' }
if (-not $PngPath) { $PngPath = Join-Path $root 'app\icon.png' }
Add-Type -AssemblyName System.Drawing

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# Everything below is drawn on a 256x256 grid and scaled to the requested size.
function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.ScaleTransform($size / 256.0, $size / 256.0)

  # rounded blue tile
  $tile = New-RoundedPath 8 8 240 240 46
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point 20, 12), (New-Object System.Drawing.Point 236, 244),
    [System.Drawing.Color]::FromArgb(255, 59, 130, 246), [System.Drawing.Color]::FromArgb(255, 30, 64, 175))
  $g.FillPath($grad, $tile)

  # page shadow + page
  $shadow = New-RoundedPath 62 44 134 176 8
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 0, 0, 0))), $shadow)
  $page = New-RoundedPath 56 38 134 176 8
  $g.FillPath([System.Drawing.Brushes]::White, $page)

  # folded corner
  $fold = New-Object System.Drawing.Drawing2D.GraphicsPath
  $fold.AddPolygon(@(
    (New-Object System.Drawing.PointF 152, 38),
    (New-Object System.Drawing.PointF 190, 76),
    (New-Object System.Drawing.PointF 152, 76)))
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 191, 219, 254))), $fold)
  $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 147, 197, 253), 2)), $fold)

  # text lines on the page
  $line = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 203, 213, 225))
  foreach ($row in 0..3) {
    $w = if ($row -eq 3) { 52 } else { 88 }
    $g.FillRectangle($line, 74, 96 + ($row * 20), $w, 8)
  }

  # PDF badge
  $badge = New-RoundedPath 72 150 74 38 8
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 220, 38, 38))), $badge)
  $font = New-Object System.Drawing.Font('Segoe UI', 22, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString('PDF', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 72, 152, 74, 34), $fmt)

  # pencil, drawn rotated over the page's lower-right corner
  $state = $g.Save()
  $g.TranslateTransform(162, 160)
  $g.RotateTransform(-40)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 249, 168, 212))), -86, -15, 18, 30)   # eraser
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 148, 163, 184))), -68, -16, 12, 32)   # ferrule
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 245, 158, 11))), -56, -16, 92, 32)   # body
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 251, 191, 36))), -56, -16, 92, 10)   # highlight
  $tip = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tip.AddPolygon(@(
    (New-Object System.Drawing.PointF 36, -16),
    (New-Object System.Drawing.PointF 36, 16),
    (New-Object System.Drawing.PointF 68, 0)))
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 253, 230, 138))), $tip)
  $lead = New-Object System.Drawing.Drawing2D.GraphicsPath
  $lead.AddPolygon(@(
    (New-Object System.Drawing.PointF 54, -7),
    (New-Object System.Drawing.PointF 54, 7),
    (New-Object System.Drawing.PointF 68, 0)))
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 51, 65, 85))), $lead)
  $g.Restore($state)

  $g.Dispose()
  return $bmp
}

function Resize-Bitmap([System.Drawing.Bitmap]$src, [int]$size) {
  $dst = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $size, $size))
  $g.Dispose()
  return $dst
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  return , $bytes
}

# 32bpp bitmap in the layout an .ico expects (BITMAPINFOHEADER + bottom-up BGRA + AND mask).
function Get-DibBytes([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width; $h = $bmp.Height
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $locked = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $locked.Stride
  $pixels = New-Object byte[] ($stride * $h)
  [Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $pixels, 0, $pixels.Length)
  $bmp.UnlockBits($locked)

  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter $ms
  $bw.Write([uint32]40)
  $bw.Write([int32]$w)
  $bw.Write([int32]($h * 2))          # height counts the XOR and AND masks
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]0)                # BI_RGB
  $bw.Write([uint32]($w * $h * 4))
  $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
  for ($y = $h - 1; $y -ge 0; $y--) { $bw.Write($pixels, $y * $stride, $w * 4) }
  $maskRow = [int][math]::Ceiling($w / 32.0) * 4
  $bw.Write((New-Object byte[] ($maskRow * $h)))   # opaque everywhere; alpha does the work
  $bw.Flush()
  $bytes = $ms.ToArray()
  $ms.Dispose()
  return , $bytes
}

$masterBmp = New-IconBitmap $MasterSize

$small = Resize-Bitmap $masterBmp 256
$small.Save($PngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$sizes = 16, 24, 32, 48, 64, 128, 256
$images = @()
foreach ($s in $sizes) {
  $b = Resize-Bitmap $masterBmp $s
  # PNG entries for the big sizes (keeps the file small), DIB for the rest.
  $data = [byte[]]$(if ($s -ge 128) { Get-PngBytes $b } else { Get-DibBytes $b })
  $images += [pscustomobject]@{ Size = $s; Data = $data; Bitmap = $b }
}

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$images.Count)
$offset = 6 + (16 * $images.Count)
foreach ($img in $images) {
  $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim)
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$img.Data.Length)
  $bw.Write([uint32]$offset)
  $offset += $img.Data.Length
}
foreach ($img in $images) { $bw.Write([byte[]]$img.Data) }
$bw.Flush()
[IO.File]::WriteAllBytes($IcoPath, $ms.ToArray())

if ($PreviewPath) {
  $pad = 16
  $width = ($sizes | Measure-Object -Sum).Sum + ($pad * ($sizes.Count + 1))
  $height = 256 + ($pad * 2)
  $sheet = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $sg = [System.Drawing.Graphics]::FromImage($sheet)
  $sg.Clear([System.Drawing.Color]::FromArgb(255, 17, 24, 39))
  $x = $pad
  foreach ($img in $images) {
    $sg.DrawImage($img.Bitmap, $x, $height - $pad - $img.Size)
    $x += $img.Size + $pad
  }
  $sg.Dispose()
  $sheet.Save($PreviewPath, [System.Drawing.Imaging.ImageFormat]::Png)
}

$icoKb = [math]::Round((Get-Item $IcoPath).Length / 1KB, 1)
Write-Host "wrote $IcoPath ($icoKb KB: $($sizes -join ', ') px) and $PngPath" -ForegroundColor Green
if ($PreviewPath) { Write-Host "preview: $PreviewPath" -ForegroundColor DarkGray }
