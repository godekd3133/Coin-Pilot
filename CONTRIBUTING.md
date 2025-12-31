# 기여 가이드

프로젝트에 기여해주셔서 감사합니다.

## 시작하기

1. 저장소를 포크합니다
2. 로컬에 클론합니다: `git clone https://github.com/your-username/Coin-Pilot.git`
3. 의존성을 설치합니다: `npm install`
4. `.env.example`을 복사해서 `.env`를 만들고 설정합니다

## 개발

```bash
npm run dev      # 개발 모드 실행
npm run backtest # 백테스팅
```

## 커밋 메시지

다음 형식을 따라주세요:

- `feat:` 새로운 기능
- `fix:` 버그 수정
- `docs:` 문서 수정
- `refactor:` 리팩토링
- `chore:` 기타 작업

예시: `feat: Add stop-loss notification`

## Pull Request

1. 기능 브랜치를 만듭니다: `git checkout -b feature/my-feature`
2. 변경사항을 커밋합니다
3. 브랜치를 푸시합니다: `git push origin feature/my-feature`
4. PR을 생성합니다

## 주의사항

- DRY_RUN 모드에서 충분히 테스트하세요
- API 키를 커밋하지 마세요
- 기존 코드 스타일을 따라주세요
