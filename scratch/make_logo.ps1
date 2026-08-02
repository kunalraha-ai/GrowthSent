Add-Type -AssemblyName System.Drawing

$width = 640
$height = 144

$bmp = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# Clear background with dark slate #171817
$graphics.Clear([System.Drawing.Color]::FromArgb(255, 23, 24, 23))

$whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 247, 247, 243))
$limeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 164, 239, 81))

# Three brand mark indicator bars
$graphics.FillRectangle($whiteBrush, 32, 60, 14, 44)
$graphics.FillRectangle($whiteBrush, 56, 32, 14, 72)
$graphics.FillRectangle($limeBrush, 80, 48, 14, 56)

# GrowthSent Typography
$font = New-Object System.Drawing.Font("Arial", 46, [System.Drawing.FontStyle]::Bold)
$graphics.DrawString("GrowthSent", $font, $whiteBrush, 120, 32)

$pngPath = "C:\Users\kunal\OneDrive\pineapple\GrowthSent\public\logo.png"
$jpgPath = "C:\Users\kunal\OneDrive\pineapple\GrowthSent\public\logo.jpg"

$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Save($jpgPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)

$graphics.Dispose()
$bmp.Dispose()
Write-Host "Successfully generated logo.png and logo.jpg"
