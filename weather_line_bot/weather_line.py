import os
import requests
import datetime
from linebot import LineBotApi
from linebot.models import TextSendMessage
from datetime import datetime, timezone, timedelta

# 今日の月と日を取得
JST = timezone(timedelta(hours=9))
now_time = datetime.now(JST)

# LINEのChannelAccessTokenとUSER IDを取得する
LINE_CHANNEL_ACCESS_TOKEN = os.getenv("LINE_CHANNEL_ACCESS_TOKEN")
USER_ID = os.getenv("USER_ID")

line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)

# 気象庁から天気情報を取得 (埼玉県：熊谷地方気象台)
url = "https://www.jma.go.jp/bosai/forecast/data/forecast/110000.json"
# 気温データ用のURL
temp_url = "https://www.jma.go.jp/bosai/forecast/data/overview_forecast/110000.json"

try:
    response = requests.get(url)
    response.raise_for_status()
    weather_data = response.json()

    # 地域名と天気情報を抜き出す
    area_name = weather_data[0]["timeSeries"][0]["areas"][1]["area"]["name"] # 南部
    today_weather = weather_data[0]["timeSeries"][0]["areas"][1]["weathers"][0] # 南部

    # 天気に絵文字をつける
    if "雷" in today_weather:
        today_weather_icon = today_weather + " ⛈"
    elif "雪" in today_weather:
        today_weather_icon = today_weather + " ⛄"
    elif "雨" in today_weather:
        today_weather_icon = today_weather + " ☔"
    elif "くもり" in today_weather and "晴れ" in today_weather:
        today_weather_icon = today_weather + " 🌤"
    elif "くもり" in today_weather:
        today_weather_icon = today_weather + " ☁"
    elif "晴れ" in today_weather:
        today_weather_icon = today_weather + " ☀"
    else:
        today_weather_icon = today_weather

    # 概要情報（気温など）も取得してみる
    temp_res = requests.get(temp_url)
    overview_text = ""
    if temp_res.status_code == 200:
        overview_data = temp_res.json()
        # overview_data["text"] には全体の気象概況が含まれています
        # 必要に応じてテキストの一部を抽出することも可能です

    # 凝ったレイアウトのメッセージ作成
    message_text = (
        f"━━━━━━━━━━━━━━━\n"
        f" 🌿 本日の天気予報 🌿\n"
        f"━━━━━━━━━━━━━━━\n"
        f"📅 日付：{now_time.month}月{now_time.day}日\n"
        f"📍 地域：埼玉県 {area_name}\n\n"
        f"【天気】\n"
        f" {today_weather_icon.strip()}\n\n"
        f"今日も一日頑張っていきましょう！🔥\n"
        f"━━━━━━━━━━━━━━━"
    )

    # LINEにメッセージを送信
    line_bot_api.push_message(USER_ID, TextSendMessage(text=message_text))
    print("LINEへの天気通知が成功しました")

# エラー処理
except Exception as e:
    print(f"エラーが発生しました：{e}")