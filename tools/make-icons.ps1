Add-Type -AssemblyName System.Drawing

function New-RoundedRectPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
  $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
  $p.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw-Icon([int]$size, [string]$path, [bool]$maskable) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = [single]($size / 512.0)
  $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,18,22,31))
  if ($maskable) {
    $g.FillRectangle($bgBrush, 0, 0, [single]$size, [single]$size)
  } else {
    $g.FillPath($bgBrush, (New-RoundedRectPath 0 0 ([single]$size) ([single]$size) (112 * $s)))
  }

  $rectG = New-Object System.Drawing.RectangleF(0, 0, [single]$size, [single]$size)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rectG,
    [System.Drawing.Color]::FromArgb(255,79,140,255),
    [System.Drawing.Color]::FromArgb(255,124,92,255), 45)

  $pen = New-Object System.Drawing.Pen($brush, [single](34 * $s))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawArc($pen, (128 * $s), (132 * $s), (256 * $s), (256 * $s), 180, 180)

  $cupY = 288 * $s
  $g.FillPath($brush, (New-RoundedRectPath (92 * $s) $cupY (72 * $s) (128 * $s) (30 * $s)))
  $g.FillPath($brush, (New-RoundedRectPath (348 * $s) $cupY (72 * $s) (128 * $s) (30 * $s)))

  $note = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,232,236,244))
  $g.FillEllipse($note, (226 * $s), (220 * $s), (60 * $s), (60 * $s))
  $g.FillRectangle($note, (244 * $s), (142 * $s), (24 * $s), (108 * $s))

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "created $path"
}

$dir = "C:\repotree-v1\ID1_Dev\AudioCron\icons"
Draw-Icon 192 "$dir\icon-192.png" $false
Draw-Icon 512 "$dir\icon-512.png" $false
Draw-Icon 512 "$dir\icon-maskable-512.png" $true
Draw-Icon 180 "$dir\apple-touch-icon.png" $true
